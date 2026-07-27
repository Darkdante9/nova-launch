import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cors from "cors";
import { corsOptions } from "../config/cors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(extraRoutes?: (app: express.Application) => void) {
  const app = express();
  app.use(cors(corsOptions));
  app.get("/test", (_req, res) => res.json({ message: "success" }));
  app.put("/test", (_req, res) => res.json({ message: "success" }));
  app.delete("/test", (_req, res) => res.json({ message: "success" }));
  extraRoutes?.(app);
  return app;
}

// ---------------------------------------------------------------------------
// Existing baseline tests
// ---------------------------------------------------------------------------

describe("CORS Configuration", () => {
  let app: express.Application;

  beforeEach(() => {
    app = buildApp();
  });

  it("should allow requests from allowed origins", async () => {
    const response = await request(app)
      .get("/test")
      .set("Origin", "http://localhost:5173");

    expect(response.status).toBe(200);
    expect(response.header["access-control-allow-origin"]).toBe(
      "http://localhost:5173"
    );
    expect(response.header["access-control-allow-credentials"]).toBe("true");
  });

  it("should block requests from disallowed origins", async () => {
    const response = await request(app)
      .get("/test")
      .set("Origin", "http://malicious-site.com");

    expect(response.status).toBe(500);
  });

  it("should handle preflight OPTIONS requests", async () => {
    const response = await request(app)
      .options("/test")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type, Authorization");

    expect(response.status).toBe(204);
    expect(response.header["access-control-allow-origin"]).toBe(
      "http://localhost:5173"
    );
    expect(response.header["access-control-allow-methods"]).toContain("POST");
    expect(response.header["access-control-allow-headers"]).toContain(
      "Content-Type"
    );
    expect(response.header["access-control-allow-headers"]).toContain(
      "Authorization"
    );
    expect(response.header["access-control-max-age"]).toBe("86400");
  });

  it("should allow requests with no origin (e.g., server-side or curl)", async () => {
    const response = await request(app).get("/test");

    expect(response.status).toBe(200);
    expect(response.header["access-control-allow-origin"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regression Matrix: Preflight OPTIONS × HTTP method × origin
// ---------------------------------------------------------------------------

describe("CORS regression matrix – preflight OPTIONS across methods and origins", () => {
  let app: express.Application;

  beforeEach(() => {
    app = buildApp();
  });

  const ALLOWED_ORIGIN = "http://localhost:5173";

  // Each row: [method, origin, expectedStatus, shouldHaveCorsHeaders]
  const preflightMatrix: [string, string, number, boolean][] = [
    // Authorized origin – PUT
    ["PUT", ALLOWED_ORIGIN, 204, true],
    // Authorized origin – DELETE
    ["DELETE", ALLOWED_ORIGIN, 204, true],
    // Unauthorized origin – PUT → cors middleware errors → 500
    ["PUT", "http://evil.com", 500, false],
    // Unauthorized origin – DELETE
    ["DELETE", "http://evil.com", 500, false],
  ];

  it.each(preflightMatrix)(
    "OPTIONS /%s from origin %s → %d (cors headers present: %s)",
    async (method, origin, expectedStatus, shouldHaveCorsHeaders) => {
      const response = await request(app)
        .options("/test")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", method)
        .set("Access-Control-Request-Headers", "Content-Type, Authorization");

      expect(response.status).toBe(expectedStatus);

      if (shouldHaveCorsHeaders) {
        expect(response.header["access-control-allow-origin"]).toBe(
          ALLOWED_ORIGIN
        );
        expect(
          response.header["access-control-allow-methods"]
        ).toContain(method);
        expect(response.header["access-control-allow-headers"]).toContain(
          "Content-Type"
        );
        expect(response.header["access-control-allow-headers"]).toContain(
          "Authorization"
        );
      } else {
        expect(
          response.header["access-control-allow-origin"]
        ).toBeUndefined();
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Regression Matrix: GET/POST/PUT/DELETE × authorized vs unauthorised origin
// ---------------------------------------------------------------------------

describe("CORS regression matrix – simple requests across methods", () => {
  let app: express.Application;

  beforeEach(() => {
    app = buildApp();
  });

  const ALLOWED_ORIGIN = "http://localhost:5173";

  // Simple (non-preflight) requests
  const simpleRequestMatrix: [string, string, number][] = [
    ["GET", ALLOWED_ORIGIN, 200],
    ["POST", ALLOWED_ORIGIN, 404], // no POST handler wired – still tests CORS headers
    ["PUT", ALLOWED_ORIGIN, 200],
    ["DELETE", ALLOWED_ORIGIN, 200],
    ["GET", "http://attacker.io", 500],
    ["PUT", "http://attacker.io", 500],
    ["DELETE", "http://attacker.io", 500],
  ];

  it.each(simpleRequestMatrix)(
    "%s from %s → status %d",
    async (method, origin, expectedStatus) => {
      const response = await request(app)
        [method.toLowerCase() as "get" | "post" | "put" | "delete"]("/test")
        .set("Origin", origin);

      expect(response.status).toBe(expectedStatus);

      if (origin === ALLOWED_ORIGIN && expectedStatus !== 500) {
        expect(response.header["access-control-allow-origin"]).toBe(
          ALLOWED_ORIGIN
        );
        expect(response.header["access-control-allow-credentials"]).toBe(
          "true"
        );
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Security Edge Case: Wildcard + credentials must never be reflected together
// ---------------------------------------------------------------------------

describe("CORS security – wildcard origin must not accompany credentials", () => {
  /**
   * RFC 6454 / Fetch spec: a response with Access-Control-Allow-Credentials:true
   * MUST NOT also set Access-Control-Allow-Origin: * .
   * Our CORS config uses a whitelist + credentials:true, so the wildcard should
   * never appear.  We also verify that a wildcard-only config (no credentials)
   * does NOT set the credentials header.
   */

  it("production config never reflects wildcard for credentialed requests", async () => {
    const app = buildApp();

    const response = await request(app)
      .get("/test")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", "session=abc123");

    expect(response.header["access-control-allow-origin"]).not.toBe("*");
    expect(response.header["access-control-allow-credentials"]).toBe("true");
    // Explicit whitelist origin echoed back
    expect(response.header["access-control-allow-origin"]).toBe(
      "http://localhost:5173"
    );
  });

  it("wildcard-only config must not set credentials header", async () => {
    // Build a separate app using a wildcard cors config (no credentials)
    const wildcardApp = express();
    wildcardApp.use(cors({ origin: "*", credentials: false }));
    wildcardApp.get("/test", (_req, res) => res.json({ ok: true }));

    const response = await request(wildcardApp)
      .get("/test")
      .set("Origin", "http://any-origin.com");

    expect(response.header["access-control-allow-origin"]).toBe("*");
    // credentials header must be absent or falsy – browsers would reject the
    // combination of wildcard + credentials anyway
    const credHeader = response.header["access-control-allow-credentials"];
    expect(credHeader === undefined || credHeader === "false").toBe(true);
  });

  it("disallowed origin never receives credentials header", async () => {
    const app = buildApp();

    const response = await request(app)
      .get("/test")
      .set("Origin", "http://phishing-nova.domain");

    // Blocked by CORS – no credentials header leaked
    expect(response.header["access-control-allow-credentials"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regression Matrix: Subdomain matching integrity
// ---------------------------------------------------------------------------

describe("CORS regression matrix – subdomain matching", () => {
  /**
   * The allowedOrigins whitelist contains exactly "http://localhost:5173".
   * Verify that partial string matches, valid-looking subdomains and
   * lookalike domains are all rejected.
   */

  let app: express.Application;

  beforeEach(() => {
    app = buildApp();
  });

  const ALLOWED = "http://localhost:5173";

  // [origin, isAllowed, description]
  const subdomainMatrix: [string, boolean, string][] = [
    [ALLOWED, true, "exact allowed origin"],
    [
      "https://staging.nova.domain",
      false,
      "valid-looking subdomain not in whitelist",
    ],
    [
      "https://malicious-nova.domain",
      false,
      "partial root string match (should be blocked)",
    ],
    [
      "https://localhost.evil.com",
      false,
      "subdomain of evil domain spoofing localhost",
    ],
    [
      "http://localhost:5173.evil.com",
      false,
      "trusted origin embedded as subdomain",
    ],
    ["http://localhost:9999", false, "correct host but wrong port"],
    ["https://localhost:5173", false, "correct host/port but wrong scheme"],
    [
      "http://localhost:5173/extra",
      false,
      "extra path component appended to allowed origin",
    ],
  ];

  it.each(subdomainMatrix)(
    "origin %s (allowed: %s) – %s",
    async (origin, isAllowed, _description) => {
      const response = await request(app)
        .get("/test")
        .set("Origin", origin);

      if (isAllowed) {
        expect(response.status).toBe(200);
        expect(response.header["access-control-allow-origin"]).toBe(ALLOWED);
        expect(response.header["access-control-allow-credentials"]).toBe(
          "true"
        );
      } else {
        // Rejected origins cause the cors middleware's error callback to fire,
        // which Express surfaces as a 500.
        expect(response.status).toBe(500);
        expect(
          response.header["access-control-allow-origin"]
        ).toBeUndefined();
        expect(
          response.header["access-control-allow-credentials"]
        ).toBeUndefined();
      }
    }
  );

  it("preflight from unlisted subdomain is rejected – no allow-origin reflected", async () => {
    const response = await request(app)
      .options("/test")
      .set("Origin", "https://staging.nova.domain")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "Content-Type");

    expect(response.status).toBe(500);
    expect(response.header["access-control-allow-origin"]).toBeUndefined();
  });
});
