import { IsString, IsNotEmpty, IsOptional, IsEnum } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class WalletAuthDto {
  @ApiProperty({
    description: "Stellar wallet public key (G-address, 56 characters)",
    example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    minLength: 56,
    maxLength: 56,
    pattern: "^G[A-Z2-7]{55}$",
  })
  @IsString()
  @IsNotEmpty()
  publicKey: string;

  @ApiProperty({
    description:
      "Ed25519 signature over the nonce, base64-encoded. Produced by signing " +
      "the challenge message with the wallet's private key.",
    example:
      "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789+/aBcDeFgHiJkLmNoPqRsTuVwXyZ012=",
  })
  @IsString()
  @IsNotEmpty()
  signature: string;

  @ApiProperty({
    description: "The nonce value returned by GET /auth/nonce (UUID v4 format)",
    example: "3f7e1b2a-9c4d-4e8f-a1b2-c3d4e5f60718",
    format: "uuid",
  })
  @IsString()
  @IsNotEmpty()
  nonce: string;
}

export class RefreshTokenDto {
  @ApiProperty({
    description:
      "A valid, non-expired JWT refresh token previously issued by POST /auth/login " +
      "or POST /auth/refresh.",
    example:
      "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJHQUFaST...",
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class ApiKeyAuthDto {
  @ApiProperty({ description: "API key for programmatic access" })
  @IsString()
  @IsNotEmpty()
  apiKey: string;
}

export class AuthResponseDto {
  @ApiProperty({
    description: "Short-lived JWT access token (Bearer). Valid for 15 minutes.",
    example:
      "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJHQUFaST...",
  })
  accessToken: string;

  @ApiProperty({
    description:
      "Longer-lived JWT refresh token. Used to obtain a new access token via " +
      "POST /auth/refresh. Valid for 7 days.",
    example:
      "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJHQUFaST...",
  })
  refreshToken: string;

  @ApiProperty({
    description: "Seconds until the access token expires.",
    example: 900,
  })
  expiresIn: number;

  @ApiProperty({
    description: "Token type — always 'Bearer'.",
    example: "Bearer",
  })
  tokenType: string;

  @ApiProperty({
    description: "Stellar wallet address (G-address) of the authenticated user.",
    example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
  })
  walletAddress: string;
}

export class NonceResponseDto {
  @ApiProperty({
    description: "One-time nonce (UUID v4) to be signed by the wallet.",
    example: "3f7e1b2a-9c4d-4e8f-a1b2-c3d4e5f60718",
    format: "uuid",
  })
  nonce: string;

  @ApiProperty({
    description: "Unix timestamp (seconds) at which the nonce expires.",
    example: 1719100800,
  })
  expiresAt: number;

  @ApiProperty({
    description: "Full challenge message that the wallet must sign.",
    example:
      "Sign this message to authenticate: 3f7e1b2a-9c4d-4e8f-a1b2-c3d4e5f60718",
  })
  message: string;
}

export class JwtPayloadDto {
  @ApiProperty({
    description: "Subject claim — Stellar wallet address of the token holder.",
    example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
  })
  sub: string; // wallet address

  @ApiProperty({
    description: "Stellar wallet address (duplicate of sub for convenience).",
    example: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
  })
  walletAddress: string;

  @ApiProperty({
    description: "Token type — 'access' for access tokens, 'refresh' for refresh tokens.",
    enum: ["access", "refresh"],
    example: "access",
  })
  type: "access" | "refresh";

  @ApiPropertyOptional({
    description: "Issued-at claim (Unix timestamp in seconds).",
    example: 1719100000,
  })
  iat?: number;

  @ApiPropertyOptional({
    description: "Expiry claim (Unix timestamp in seconds).",
    example: 1719100900,
  })
  exp?: number;

  @ApiPropertyOptional({
    description: "JWT ID — unique token identifier used for revocation.",
    example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    format: "uuid",
  })
  jti?: string; // JWT ID for revocation
}
