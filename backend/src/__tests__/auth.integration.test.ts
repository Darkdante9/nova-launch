import { describe, it, expect, beforeEach } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import * as jwt from "jsonwebtoken";

import { AuthService } from "../auth/auth.service";
import { TokenService } from "../auth/token.service";
import { NonceService } from "../auth/nonce.service";
import { StellarSignatureService } from "../auth/stellar-signature.service";

// ---------------------------------------------------------------------------
// Test fixtures — signing keys used exclusively in tests
// ---------------------------------------------------------------------------

const TEST_ACCESS_SECRET = "test-integration-access-secret-32chars!";
const TEST_REFRESH_SECRET = "test-integration-refresh-secret-32c!";

const CONFIG_MAP: Record<string, string> = {
  JWT_ACCESS_SECRET: TEST_ACCESS_SECRET,
  JWT_REFRESH_SECRET: TEST_REFRESH_SECRET,
};

const TEST_WALLET = "GTEST_WALLET_INTEGRATION_ABC123456789";

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------

async function buildModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
      JwtModule.register({ secret: TEST_ACCESS_SECRET }),
    ],
    providers: [
      AuthService,
      TokenService,
      NonceService,
      StellarSignatureService,
      {
        provide: ConfigService,
        useValue: {
          get: (key: string, fallback?: string) =>
            CONFIG_MAP[key] ?? fallback ?? "",
        },
      },
    ],
  }).compile();
}

// ---------------------------------------------------------------------------
// Helper — craft a token with arbitrary overrides using jsonwebtoken directly
// ---------------------------------------------------------------------------

function craftToken(
  payload: Record<string, unknown>,
  secret: string,
  options: jwt.SignOptions = {}
): string {
  return jwt.sign(payload, secret, options);
}

function craftExpiredAccessToken(walletAddress: string): string {
  return craftToken(
    { sub: walletAddress, walletAddress, type: "access", jti: "expired-jti" },
    TEST_ACCESS_SECRET,
    { expiresIn: -1 } // already expired
  );
}

function craftExpiredRefreshToken(walletAddress: string): string {
  return craftToken(
    {
      sub: walletAddress,
      walletAddress,
      type: "refresh",
      jti: "expired-refresh-jti",
    },
    TEST_REFRESH_SECRET,
    { expiresIn: -1 }
  );
}

function craftTamperedAccessToken(walletAddress: string): string {
  // Sign with a wrong secret so verification fails
  return craftToken(
    { sub: walletAddress, walletAddress, type: "access", jti: "tampered-jti" },
    "wrong-secret"
  );
}

// ---------------------------------------------------------------------------
// Scenario: successful token refresh
// ---------------------------------------------------------------------------

describe("AuthService — JWT integration tests", () => {
  let module: TestingModule;
  let authService: AuthService;
  let tokenService: TokenService;

  beforeEach(async () => {
    module = await buildModule();
    authService = module.get(AuthService);
    tokenService = module.get(TokenService);
  });

  describe("successful refresh — valid refresh token yields a new token pair", () => {
    it("returns new access and refresh tokens for a valid refresh token", () => {
      const { refreshToken } = tokenService.generateTokenPair(TEST_WALLET);

      const result = authService.refreshTokens({ refreshToken });

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.walletAddress).toBe(TEST_WALLET);
      expect(result.tokenType).toBe("Bearer");
    });

    it("new access token is independently verifiable", () => {
      const { refreshToken } = tokenService.generateTokenPair(TEST_WALLET);
      const { accessToken } = authService.refreshTokens({ refreshToken });

      const payload = jwt.verify(accessToken, TEST_ACCESS_SECRET) as Record<
        string,
        unknown
      >;
      expect(payload.walletAddress).toBe(TEST_WALLET);
      expect(payload.type).toBe("access");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario: expired refresh token rejected
  // -------------------------------------------------------------------------

  describe("expired refresh token — must be rejected with 401", () => {
    it("throws UnauthorizedException for an already-expired refresh token", () => {
      const expiredRefresh = craftExpiredRefreshToken(TEST_WALLET);

      expect(() => authService.refreshTokens({ refreshToken: expiredRefresh })).toThrow(
        UnauthorizedException
      );
    });

    it("does not issue a new token pair when the refresh token is expired", () => {
      const expiredRefresh = craftExpiredRefreshToken(TEST_WALLET);
      let issued = false;

      try {
        authService.refreshTokens({ refreshToken: expiredRefresh });
        issued = true;
      } catch {
        // expected
      }

      expect(issued).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario: replayed access token rejected
  // -------------------------------------------------------------------------

  describe("replay detection — revoked JTI must be rejected", () => {
    it("throws UnauthorizedException when a token's JTI has been revoked (replayed)", () => {
      const { accessToken } = tokenService.generateTokenPair(TEST_WALLET);

      // Decode to get the JTI, then revoke it
      const decoded = jwt.decode(accessToken) as Record<string, unknown>;
      const jti = decoded.jti as string;
      tokenService.revokeToken(jti);

      // Attempting to use the now-revoked token must fail
      expect(() => tokenService.verifyAccessToken(accessToken)).toThrow(
        UnauthorizedException
      );
    });

    it("accepts the token before revocation and rejects after", () => {
      const { accessToken } = tokenService.generateTokenPair(TEST_WALLET);

      // Before revocation: valid
      expect(() => tokenService.verifyAccessToken(accessToken)).not.toThrow();

      // Revoke
      const decoded = jwt.decode(accessToken) as Record<string, unknown>;
      tokenService.revokeToken(decoded.jti as string);

      // After revocation: rejected
      expect(() => tokenService.verifyAccessToken(accessToken)).toThrow(
        UnauthorizedException
      );
    });

    it("rejects an expired access token even without explicit revocation", () => {
      const expiredAccess = craftExpiredAccessToken(TEST_WALLET);

      expect(() => tokenService.verifyAccessToken(expiredAccess)).toThrow(
        UnauthorizedException
      );
    });

    it("rejects a token signed with the wrong secret (tampered)", () => {
      const tampered = craftTamperedAccessToken(TEST_WALLET);

      expect(() => tokenService.verifyAccessToken(tampered)).toThrow(
        UnauthorizedException
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scenario: refresh token rotation — old refresh token invalidated after use
  // -------------------------------------------------------------------------

  describe("refresh token rotation — old refresh JTI revoked after rotation", () => {
    it("revokes the old refresh token JTI after issuing a new token pair", () => {
      const first = tokenService.generateTokenPair(TEST_WALLET);
      const oldRefreshDecoded = jwt.decode(first.refreshToken) as Record<
        string,
        unknown
      >;
      const oldJti = oldRefreshDecoded.jti as string;

      // Perform rotation
      authService.refreshTokens({ refreshToken: first.refreshToken });

      // The old refresh token's JTI must now be revoked
      expect(() =>
        tokenService.verifyRefreshToken(first.refreshToken)
      ).toThrow(UnauthorizedException);
    });

    it("new refresh token from rotation is independently valid", () => {
      const first = tokenService.generateTokenPair(TEST_WALLET);
      const rotated = authService.refreshTokens({
        refreshToken: first.refreshToken,
      });

      expect(() =>
        tokenService.verifyRefreshToken(rotated.refreshToken)
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario: concurrent refresh race — only one rotation should succeed
  // -------------------------------------------------------------------------

  describe("concurrent refresh race — only the first rotation succeeds", () => {
    it("second concurrent refresh with the same token throws after the first succeeds", () => {
      const { refreshToken } = tokenService.generateTokenPair(TEST_WALLET);

      // First rotation succeeds
      const first = authService.refreshTokens({ refreshToken });
      expect(first.accessToken).toBeDefined();

      // Second rotation with the same refresh token fails because the JTI was revoked
      expect(() => authService.refreshTokens({ refreshToken })).toThrow(
        UnauthorizedException
      );
    });

    it("each concurrent attempt on the same revoked token fails independently", () => {
      const { refreshToken } = tokenService.generateTokenPair(TEST_WALLET);

      // Simulate two concurrent requests arriving after the token was rotated once
      authService.refreshTokens({ refreshToken });

      let failCount = 0;
      for (let i = 0; i < 5; i++) {
        try {
          authService.refreshTokens({ refreshToken });
        } catch {
          failCount++;
        }
      }

      // All 5 concurrent re-uses must have failed
      expect(failCount).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario: token type enforcement — refresh token must not be used as access
  // -------------------------------------------------------------------------

  describe("token type enforcement", () => {
    it("rejects a refresh token when used as an access token", () => {
      const { refreshToken } = tokenService.generateTokenPair(TEST_WALLET);

      expect(() => tokenService.verifyAccessToken(refreshToken)).toThrow(
        UnauthorizedException
      );
    });

    it("rejects an access token when used as a refresh token", () => {
      const { accessToken } = tokenService.generateTokenPair(TEST_WALLET);

      expect(() => tokenService.verifyRefreshToken(accessToken)).toThrow(
        UnauthorizedException
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scenario: logout revokes the access token JTI
  // -------------------------------------------------------------------------

  describe("logout — revokes the JTI so the token cannot be replayed", () => {
    it("logout revokes the JTI and subsequent verifyAccessToken throws", () => {
      const { accessToken } = tokenService.generateTokenPair(TEST_WALLET);
      const decoded = jwt.decode(accessToken) as Record<string, unknown>;

      authService.logout(decoded.jti as string);

      expect(() => tokenService.verifyAccessToken(accessToken)).toThrow(
        UnauthorizedException
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scenario: requestNonce rejects invalid Stellar public keys
  // -------------------------------------------------------------------------

  describe("requestNonce — rejects malformed Stellar public keys", () => {
    it("throws BadRequestException for a clearly invalid public key", () => {
      expect(() => authService.requestNonce("not-a-stellar-key")).toThrow(
        BadRequestException
      );
    });
  });
});
