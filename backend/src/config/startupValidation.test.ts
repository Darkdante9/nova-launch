/**
 * Tests for validateEnvVars() — fail-fast startup environment variable validation.
 * Issue: #1355
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal set of env vars that satisfies all required schemas. */
function validEnv(): Record<string, string> {
  return {
    // Auth
    JWT_SECRET: 'supersecretjwtkey',
    ADMIN_JWT_SECRET: 'supersecretadminkey',
    // Stellar
    STELLAR_NETWORK: 'testnet',
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/test',
    // IPFS
    PINATA_API_KEY: 'pinata-key-abc123',
    PINATA_API_SECRET: 'pinata-secret-xyz789',
    // Notifications
    SENDGRID_API_KEY: 'SG.test-key',
    TWILIO_ACCOUNT_SID: 'ACtest00000000000000000000000000',
    TWILIO_AUTH_TOKEN: 'twilio-auth-token',
    TWILIO_PHONE_NUMBER: '+15005550006',
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('validateEnvVars', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Prevent process.exit from killing the test runner
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => {
      throw new Error(`process.exit(${_code})`);
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('does not exit when all required vars are present and valid', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    expect(() => validateEnvVars(validEnv() as NodeJS.ProcessEnv)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ── Required var — missing triggers exit(1) ────────────────────────────────

  it('calls process.exit(1) when JWT_SECRET is missing', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    const env = validEnv() as NodeJS.ProcessEnv;
    delete env.JWT_SECRET;

    expect(() => validateEnvVars(env)).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('JWT_SECRET')
    );
  });

  it('calls process.exit(1) when SENDGRID_API_KEY is missing', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    const env = validEnv() as NodeJS.ProcessEnv;
    delete env.SENDGRID_API_KEY;

    expect(() => validateEnvVars(env)).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('SENDGRID_API_KEY')
    );
  });

  it('calls process.exit(1) when PINATA_API_KEY is missing', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    const env = validEnv() as NodeJS.ProcessEnv;
    delete env.PINATA_API_KEY;

    expect(() => validateEnvVars(env)).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('PINATA_API_KEY')
    );
  });

  it('calls process.exit(1) when TWILIO_ACCOUNT_SID is missing', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    const env = validEnv() as NodeJS.ProcessEnv;
    delete env.TWILIO_ACCOUNT_SID;

    expect(() => validateEnvVars(env)).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('TWILIO_ACCOUNT_SID')
    );
  });

  it('reports ALL missing vars in a single exit, not just the first', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    // Remove three required vars from three different service groups
    const env = { ...validEnv() } as NodeJS.ProcessEnv;
    delete env.JWT_SECRET;
    delete env.SENDGRID_API_KEY;
    delete env.PINATA_API_KEY;

    expect(() => validateEnvVars(env)).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledTimes(1);

    const errorOutput = (errorSpy.mock.calls[0][0] as string);
    expect(errorOutput).toContain('JWT_SECRET');
    expect(errorOutput).toContain('SENDGRID_API_KEY');
    expect(errorOutput).toContain('PINATA_API_KEY');
  });

  // ── Format validation ──────────────────────────────────────────────────────

  it('calls process.exit(1) when TWILIO_ACCOUNT_SID does not start with AC', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    const env = {
      ...validEnv(),
      TWILIO_ACCOUNT_SID: 'XYaabbccddeeff001122334455667788',
    } as NodeJS.ProcessEnv;

    expect(() => validateEnvVars(env)).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('TWILIO_ACCOUNT_SID')
    );
  });

  it('accepts a valid TWILIO_ACCOUNT_SID starting with AC', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    const env = {
      ...validEnv(),
      TWILIO_ACCOUNT_SID: 'ACtest00000000000000000000000000',
    } as NodeJS.ProcessEnv;

    expect(() => validateEnvVars(env)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) when DATABASE_URL is set to an invalid URL', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    const env = {
      ...validEnv(),
      DATABASE_URL: 'not-a-url',
    } as NodeJS.ProcessEnv;

    expect(() => validateEnvVars(env)).toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('DATABASE_URL')
    );
  });

  // ── Optional vars — warn but do NOT exit ──────────────────────────────────

  it('logs a warning for missing optional vars but does not exit', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    // All required vars present; REDIS_URL is optional and absent
    const env = { ...validEnv() } as NodeJS.ProcessEnv;
    delete env.REDIS_URL;

    expect(() => validateEnvVars(env)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('REDIS_URL'));
  });

  it('logs a warning for SENTRY_DSN missing but does not exit', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    const env = { ...validEnv() } as NodeJS.ProcessEnv;
    delete env.SENTRY_DSN;

    expect(() => validateEnvVars(env)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    // SENTRY_DSN should appear in one of the warn calls
    const allWarnArgs = warnSpy.mock.calls.flat().join(' ');
    expect(allWarnArgs).toContain('SENTRY_DSN');
  });

  // ── Output format ──────────────────────────────────────────────────────────

  it('groups failures by service in the error output', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    const env = { ...validEnv() } as NodeJS.ProcessEnv;
    // Remove one var from Auth and one from Notifications
    delete env.JWT_SECRET;
    delete env.TWILIO_AUTH_TOKEN;

    expect(() => validateEnvVars(env)).toThrow('process.exit(1)');

    const errorOutput = (errorSpy.mock.calls[0][0] as string);
    expect(errorOutput).toContain('[Auth]');
    expect(errorOutput).toContain('[Notifications]');
  });

  it('includes an actionable message in the error output', async () => {
    const { validateEnvVars } = await import('./startupValidation');
    const env = { ...validEnv() } as NodeJS.ProcessEnv;
    delete env.JWT_SECRET;

    expect(() => validateEnvVars(env)).toThrow('process.exit(1)');
    const errorOutput = (errorSpy.mock.calls[0][0] as string);
    expect(errorOutput).toContain('.env');
  });
});
