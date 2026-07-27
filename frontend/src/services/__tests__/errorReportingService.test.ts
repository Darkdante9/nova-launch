import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildErrorReportPayload, reportError } from '../errorReportingService';
import type { ErrorTxContext } from '../../providers/ErrorContextProvider';

const emptyTxContext: ErrorTxContext = {
  txHash: null,
  ledgerSequence: null,
  walletAddress: null,
  route: null,
  network: null,
};

describe('buildErrorReportPayload', () => {
  it('extracts the message/stack and merges in the tx context', () => {
    const error = new Error('boom');
    const payload = buildErrorReportPayload(error, 'in <Foo>', {
      ...emptyTxContext,
      txHash: 'hash1',
      walletAddress: 'GTEST',
    });

    expect(payload).toMatchObject({
      message: 'boom',
      stack: error.stack,
      componentStack: 'in <Foo>',
      txHash: 'hash1',
      walletAddress: 'GTEST',
      ledgerSequence: null,
      route: null,
      network: null,
    });
  });

  it('never includes fields beyond the whitelisted set', () => {
    const payload = buildErrorReportPayload(new Error('x'), undefined, emptyTxContext);
    expect(Object.keys(payload).sort()).toEqual(
      [
        'componentStack',
        'ledgerSequence',
        'message',
        'network',
        'route',
        'stack',
        'txHash',
        'walletAddress',
      ].sort()
    );
  });
});

describe('reportError', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts the payload to /api/errors', async () => {
    await reportError(buildErrorReportPayload(new Error('boom'), undefined, emptyTxContext));

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/errors'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('swallows network failures rather than throwing', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(
      reportError(buildErrorReportPayload(new Error('boom'), undefined, emptyTxContext))
    ).resolves.toBeUndefined();
  });
});

describe('reportError with reporting disabled', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_ERROR_REPORTING_ENABLED', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('skips the network call entirely when ERROR_REPORTING_ENABLED is false', async () => {
    global.fetch = vi.fn();
    const { reportError: reportErrorWithFlagDisabled } = await import('../errorReportingService');

    await reportErrorWithFlagDisabled(
      buildErrorReportPayload(new Error('boom'), undefined, emptyTxContext)
    );

    expect(fetch).not.toHaveBeenCalled();
  });
});
