/**
 * State machine coverage for useTokenDeploy – all 12 transition paths.
 *
 * State map:
 *
 *  ┌──────────────────────────────────────────────────────┐
 *  │                STATE TRANSITIONS                     │
 *  ├────┬──────────────┬─────────────────────────────────┤
 *  │ #  │ From → To    │ Trigger                          │
 *  ├────┼──────────────┼─────────────────────────────────┤
 *  │  1 │ idle → error │ deploy() — no wallet             │
 *  │  2 │ idle → error │ deploy() — invalid params        │
 *  │  3 │ idle → error │ deploy() — invalid image         │
 *  │  4 │ idle → uploading → error │ IPFS upload fails    │
 *  │  5 │ idle → uploading → deploying │ IPFS succeeds    │
 *  │  6 │ idle → deploying │ deploy() — no metadata       │
 *  │  7 │ deploying → success │ stellar deploy succeeds   │
 *  │  8 │ deploying → error │ wallet rejected              │
 *  │  9 │ deploying → error │ network error               │
 *  │ 10 │ deploying → error │ contract revert             │
 *  │ 11 │ error → deploying (retry) │ retry() called       │
 *  │ 12 │ error → idle │ reset() called                   │
 *  └────┴──────────────┴─────────────────────────────────┘
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTokenDeploy } from '../useTokenDeploy';
import { IPFSService } from '../../services/IPFSService';
import { StellarService } from '../../services/StellarService';
import { analytics } from '../../services/analytics';
import { ErrorCode } from '../../types';

vi.mock('../../services/IPFSService');
vi.mock('../../services/StellarService');
vi.mock('../../services/analytics');
vi.mock('../../services/TransactionHistoryStorage', () => ({
  TransactionHistoryStorage: {
    getInstance: () => ({ addToken: vi.fn() }),
  },
  transactionHistoryStorage: { addToken: vi.fn() },
}));
vi.mock('../useAnalytics', () => ({
  useAnalytics: () => ({
    trackTokenDeployed: vi.fn(),
    trackTokenDeployFailed: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_WALLET = 'GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12';

const baseParams = {
  name: 'Test Token',
  symbol: 'TST',
  decimals: 7,
  initialSupply: '1000000',
  adminWallet: VALID_WALLET,
};

const mockDeployResult = {
  tokenAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  transactionHash: 'txhash-abc123',
};

function makeImage(type = 'image/png') {
  return new File(['data'], 'img.png', { type });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('useTokenDeploy – state machine (12 transitions)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(analytics.track).mockImplementation(() => {});
    vi.mocked(StellarService.prototype.isPaused).mockResolvedValue(false);
  });

  // ── T1: idle → error (no wallet) ────────────────────────────────────────

  it('T1: idle → error when deploy is called without a wallet', async () => {
    const { result } = renderHook(() => useTokenDeploy('testnet'));

    expect(result.current.status).toBe('idle');

    await act(async () => {
      await expect(
        result.current.deploy({ ...baseParams, adminWallet: '' }),
      ).rejects.toMatchObject({ code: ErrorCode.WALLET_NOT_CONNECTED });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe(ErrorCode.WALLET_NOT_CONNECTED);
    expect(result.current.isDeploying).toBe(false);
  });

  // ── T2: idle → error (invalid params) ───────────────────────────────────

  it('T2: idle → error when token params are invalid (empty name)', async () => {
    const { result } = renderHook(() => useTokenDeploy('testnet'));

    await act(async () => {
      await expect(
        result.current.deploy({ ...baseParams, name: '' }),
      ).rejects.toBeDefined();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).not.toBeNull();
    expect(result.current.isDeploying).toBe(false);
  });

  // ── T3: idle → error (invalid image file) ───────────────────────────────

  it('T3: idle → error when metadata image type is invalid', async () => {
    const { result } = renderHook(() => useTokenDeploy('testnet'));

    await act(async () => {
      await expect(
        result.current.deploy({
          ...baseParams,
          metadata: {
            image: makeImage('application/pdf'),
            description: 'desc',
          },
        }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe(ErrorCode.INVALID_INPUT);
  });

  // ── T4: idle → uploading → error (IPFS fails) ───────────────────────────

  it('T4: transitions uploading → error when IPFS upload fails', async () => {
    vi.mocked(IPFSService.prototype.uploadMetadata).mockRejectedValue(
      new Error('IPFS gateway timeout'),
    );

    const { result } = renderHook(() => useTokenDeploy('testnet'));
    const statuses: string[] = [];
    // Capture intermediate state changes by reading after act
    const params = {
      ...baseParams,
      metadata: { image: makeImage(), description: 'desc' },
    };

    await act(async () => {
      await expect(result.current.deploy(params)).rejects.toBeDefined();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe(ErrorCode.IPFS_UPLOAD_FAILED);
    expect(result.current.isDeploying).toBe(false);
  });

  // ── T5: idle → uploading → deploying (IPFS success) ─────────────────────

  it('T5: transitions uploading → deploying when IPFS upload succeeds', async () => {
    vi.mocked(IPFSService.prototype.uploadMetadata).mockResolvedValue(
      'ipfs://QmTest123',
    );
    // Keep deploy pending so we can observe the deploying state
    let resolveDeploy!: (v: typeof mockDeployResult) => void;
    vi.mocked(StellarService.prototype.deployToken).mockReturnValue(
      new Promise((r) => { resolveDeploy = r; }),
    );

    const { result } = renderHook(() => useTokenDeploy('testnet'));
    const params = {
      ...baseParams,
      metadata: { image: makeImage(), description: 'desc' },
    };

    act(() => {
      result.current.deploy(params).catch(() => {});
    });

    await waitFor(() => expect(result.current.status).toBe('deploying'));
    expect(result.current.isDeploying).toBe(true);

    await act(async () => {
      resolveDeploy(mockDeployResult);
    });

    expect(result.current.status).toBe('success');
  });

  // ── T6: idle → deploying (no metadata) ──────────────────────────────────

  it('T6: idle → deploying directly when no metadata is provided', async () => {
    let resolveDeploy!: (v: typeof mockDeployResult) => void;
    vi.mocked(StellarService.prototype.deployToken).mockReturnValue(
      new Promise((r) => { resolveDeploy = r; }),
    );

    const { result } = renderHook(() => useTokenDeploy('testnet'));

    act(() => {
      result.current.deploy(baseParams).catch(() => {});
    });

    await waitFor(() => expect(result.current.status).toBe('deploying'));
    expect(result.current.isDeploying).toBe(true);

    await act(async () => {
      resolveDeploy(mockDeployResult);
    });
  });

  // ── T7: deploying → success ──────────────────────────────────────────────

  it('T7: deploying → success when Stellar deploy resolves', async () => {
    vi.mocked(StellarService.prototype.deployToken).mockResolvedValue(mockDeployResult);

    const { result } = renderHook(() => useTokenDeploy('testnet'));

    await act(async () => {
      const res = await result.current.deploy(baseParams);
      expect(res.tokenAddress).toBe(mockDeployResult.tokenAddress);
      expect(res.transactionHash).toBe(mockDeployResult.transactionHash);
    });

    expect(result.current.status).toBe('success');
    expect(result.current.error).toBeNull();
    expect(result.current.isDeploying).toBe(false);
  });

  // ── T8: deploying → error (wallet rejected) ──────────────────────────────

  it('T8: deploying → error when wallet rejects the transaction', async () => {
    vi.mocked(StellarService.prototype.deployToken).mockRejectedValue(
      new Error('wallet sign rejected'),
    );

    const { result } = renderHook(() => useTokenDeploy('testnet'));

    await act(async () => {
      await expect(result.current.deploy(baseParams)).rejects.toBeDefined();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe(ErrorCode.WALLET_REJECTED);
  });

  // ── T9: deploying → error (network error) ────────────────────────────────

  it('T9: deploying → error on network failure during deploy', async () => {
    vi.mocked(StellarService.prototype.deployToken).mockRejectedValue(
      new Error('network request failed'),
    );

    const { result } = renderHook(() => useTokenDeploy('testnet'));

    await act(async () => {
      await expect(result.current.deploy(baseParams)).rejects.toBeDefined();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe(ErrorCode.NETWORK_ERROR);
  });

  // ── T10: deploying → error (contract revert) ─────────────────────────────

  it('T10: deploying → error when the contract simulation reverts', async () => {
    vi.mocked(StellarService.prototype.deployToken).mockRejectedValue(
      new Error('simulate transaction failed: contract revert'),
    );

    const { result } = renderHook(() => useTokenDeploy('testnet'));

    await act(async () => {
      await expect(result.current.deploy(baseParams)).rejects.toBeDefined();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe(ErrorCode.TRANSACTION_FAILED);
  });

  // ── T11: error → deploying (retry) ───────────────────────────────────────

  it('T11: error → deploying when retry() is called after failure', async () => {
    vi.mocked(StellarService.prototype.deployToken)
      .mockRejectedValueOnce(new Error('transaction failed: first attempt'))
      .mockResolvedValueOnce(mockDeployResult);

    const { result } = renderHook(() =>
      useTokenDeploy('testnet', { retryDelay: 0 }),
    );

    await act(async () => {
      await expect(result.current.deploy(baseParams)).rejects.toBeDefined();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.canRetry).toBe(true);

    await act(async () => {
      const retryResult = await result.current.retry();
      expect(retryResult?.tokenAddress).toBe(mockDeployResult.tokenAddress);
    });

    expect(result.current.status).toBe('success');
    expect(result.current.retryCount).toBe(1);
  });

  // ── T12: error → idle (reset) ────────────────────────────────────────────

  it('T12: error → idle when reset() is called', async () => {
    vi.mocked(StellarService.prototype.deployToken).mockRejectedValue(
      new Error('transaction failed'),
    );

    const { result } = renderHook(() => useTokenDeploy('testnet'));

    await act(async () => {
      await expect(result.current.deploy(baseParams)).rejects.toBeDefined();
    });

    expect(result.current.status).toBe('error');

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(result.current.retryCount).toBe(0);
    expect(result.current.canRetry).toBe(false);
    expect(result.current.statusMessage).toBe('');
  });

  // ── Cleanup: unmount during deploy does not cause state-update warnings ──

  it('unmounting during an in-flight deploy does not cause state-update warnings', async () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let resolveDeploy!: (v: typeof mockDeployResult) => void;
    vi.mocked(StellarService.prototype.deployToken).mockReturnValue(
      new Promise((r) => { resolveDeploy = r; }),
    );

    const { result, unmount } = renderHook(() => useTokenDeploy('testnet'));

    act(() => {
      result.current.deploy(baseParams).catch(() => {});
    });

    await waitFor(() => expect(result.current.status).toBe('deploying'));

    unmount();

    await act(async () => {
      resolveDeploy(mockDeployResult);
    });

    // Give React a tick to process any queued setState after unmount
    await new Promise((r) => setTimeout(r, 0));

    const stateUpdateWarning = warnSpy.mock.calls.some((args) =>
      String(args[0]).includes('unmounted component') ||
      String(args[0]).includes('state update'),
    );
    expect(stateUpdateWarning).toBe(false);

    warnSpy.mockRestore();
 * Issue #1081 — Model the useTokenDeploy hook as a state machine and lock down its transitions
 *
 * Asserts each transition:
 *   idle → deploying → success
 *   idle → uploading → deploying → success (with metadata)
 *   idle → error (validation failure)
 *   idle → deploying → error (network failure)
 *   error → idle (recovery via reset)
 *   error → deploying → success (recovery via retry)
 *
 * Also asserts the hook does not fire duplicate submissions.
 *
 * Fixtures:
 *   VALID_ADDR — a valid Stellar address (G + 55 chars from [A-Z2-7])
 *   DEPLOY_RESULT — a minimal successful deployment result
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTokenDeploy } from '../useTokenDeploy';
import { IPFSService } from '../../services/IPFSService';
import { StellarService } from '../../services/stellar.service';
import { analytics } from '../../services/analytics';
import { ErrorCode } from '../../types';
import type { WalletState } from '../../types';

vi.mock('../../services/IPFSService');
vi.mock('../../services/stellar.service');
vi.mock('../../services/analytics');

// Keep the real isValidIpfsUri so the hook's URI validation passes
import * as IPFSModule from '../../services/IPFSService';
vi.spyOn(IPFSModule, 'isValidIpfsUri').mockReturnValue(true);
vi.mock('../../services/stellar.service');
vi.mock('../../services/analytics');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Valid Stellar address: G + 55 chars from [A-Z2-7] = 56 chars total */
const VALID_ADDR = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

const WALLET: WalletState = {
  connected: true,
  address: VALID_ADDR,
  network: 'testnet',
};

const VALID_PARAMS = {
  name: 'State Machine Token',
  symbol: 'SMT',
  decimals: 7,
  initialSupply: '1000000',
  adminWallet: VALID_ADDR,
};

const DEPLOY_RESULT = {
  tokenAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  transactionHash: 'sm-tx-hash',
  timestamp: Date.now(),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(analytics.track).mockImplementation(() => {});
  // Default: contract is not paused
  vi.mocked(StellarService.prototype.isPaused).mockResolvedValue(false);
});

// ── State machine tests ───────────────────────────────────────────────────────

describe('useTokenDeploy state machine (#1081)', () => {
  describe('1. Initial state — idle', () => {
    it('starts in idle state with no error and isDeploying=false', () => {
      const { result } = renderHook(() => useTokenDeploy(WALLET));

      expect(result.current.status).toBe('idle');
      expect(result.current.error).toBeNull();
      expect(result.current.isDeploying).toBe(false);
      expect(result.current.statusMessage).toBe('');
      expect(result.current.canRetry).toBe(false);
    });
  });

  describe('2. idle → deploying → success', () => {
    it('transitions through deploying to success on a successful deploy', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(DEPLOY_RESULT), 50))
      );

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      act(() => { result.current.deploy(VALID_PARAMS); });

      await waitFor(() => expect(result.current.status).toBe('deploying'));
      expect(result.current.isDeploying).toBe(true);

      await waitFor(() => expect(result.current.status).toBe('success'));
      expect(result.current.error).toBeNull();
      expect(result.current.isDeploying).toBe(false);
    });

    it('returns the deployment result on success', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockResolvedValue(DEPLOY_RESULT);

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      let deployResult: any;
      await act(async () => {
        deployResult = await result.current.deploy(VALID_PARAMS);
      });

      expect(deployResult.tokenAddress).toBe(DEPLOY_RESULT.tokenAddress);
      expect(deployResult.transactionHash).toBe(DEPLOY_RESULT.transactionHash);
      expect(result.current.status).toBe('success');
    });
  });

  describe('3. idle → uploading → deploying → success (with metadata)', () => {
    it('transitions through uploading then deploying when metadata is provided', async () => {
      const VALID_IPFS_URI = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
      vi.mocked(IPFSService.prototype.uploadMetadata).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(VALID_IPFS_URI), 50))
      );
      vi.mocked(StellarService.prototype.deployToken).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(DEPLOY_RESULT), 50))
      );

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      const mockImage = new File(['img'], 'logo.png', { type: 'image/png' });
      const params = { ...VALID_PARAMS, metadata: { image: mockImage, description: 'A token' } };

      act(() => { result.current.deploy(params); });

      await waitFor(() => expect(result.current.status).toBe('uploading'));
      await waitFor(() => expect(result.current.status).toBe('deploying'));
      await waitFor(() => expect(result.current.status).toBe('success'));

      expect(result.current.error).toBeNull();
    });
  });

  describe('4. idle → error (validation failure)', () => {
    it('transitions to error on invalid params without entering deploying', async () => {
      const { result } = renderHook(() => useTokenDeploy(WALLET));

      await act(async () => {
        await expect(
          result.current.deploy({ ...VALID_PARAMS, name: '' })
        ).rejects.toThrow();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error?.code).toBe(ErrorCode.INVALID_INPUT);
      expect(result.current.isDeploying).toBe(false);
      // StellarService must never be called for a validation error
      expect(StellarService.prototype.deployToken).not.toHaveBeenCalled();
    });

    it('transitions to error when wallet address is missing (empty string)', async () => {
      const { result } = renderHook(() => useTokenDeploy(WALLET));

      let thrownError: any;
      await act(async () => {
        try {
          await result.current.deploy({ ...VALID_PARAMS, adminWallet: '' });
        } catch (e) {
          thrownError = e;
        }
      });

      // The hook throws with WALLET_NOT_CONNECTED code
      expect(thrownError?.code).toBe(ErrorCode.WALLET_NOT_CONNECTED);
      // StellarService is never called for a missing wallet
      expect(StellarService.prototype.deployToken).not.toHaveBeenCalled();
    });
  });

  describe('5. idle → deploying → error (network failure)', () => {
    it('transitions to error when deployToken rejects', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockRejectedValue(
        new Error('network error')
      );

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      await act(async () => {
        await expect(result.current.deploy(VALID_PARAMS)).rejects.toThrow();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.error).not.toBeNull();
      expect(result.current.canRetry).toBe(true);
    });
  });

  describe('6. error → idle (recovery via reset)', () => {
    it('reset() transitions from error back to idle and clears error', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockRejectedValue(
        new Error('tx failed')
      );

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      await act(async () => {
        await expect(result.current.deploy(VALID_PARAMS)).rejects.toThrow();
      });
      expect(result.current.status).toBe('error');

      act(() => { result.current.reset(); });

      expect(result.current.status).toBe('idle');
      expect(result.current.error).toBeNull();
      expect(result.current.retryCount).toBe(0);
      expect(result.current.canRetry).toBe(false);
    });
  });

  describe('7. error → success (recovery via retry)', () => {
    it('retry() re-enters deploying and reaches success on second attempt', async () => {
      let calls = 0;
      vi.mocked(StellarService.prototype.deployToken).mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('first attempt failed'));
        return Promise.resolve(DEPLOY_RESULT);
      });

      const { result } = renderHook(() =>
        useTokenDeploy(WALLET, { retryDelay: 0 })
      );

      await act(async () => {
        await expect(result.current.deploy(VALID_PARAMS)).rejects.toThrow();
      });
      expect(result.current.status).toBe('error');
      expect(result.current.canRetry).toBe(true);

      await act(async () => { await result.current.retry(); });

      expect(result.current.status).toBe('success');
      expect(result.current.retryCount).toBe(1);
    });
  });

  describe('8. No duplicate submissions', () => {
    it('canRetry is false while a deploy is in-flight (status=deploying)', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(DEPLOY_RESULT), 100))
      );

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      act(() => { result.current.deploy(VALID_PARAMS); });
      await waitFor(() => expect(result.current.status).toBe('deploying'));

      // canRetry must be false while deploying — retry is only valid from error state
      expect(result.current.canRetry).toBe(false);

      await waitFor(() => expect(result.current.status).toBe('success'));
    });

    it('calling deploy twice in sequence does not corrupt state', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockResolvedValue(DEPLOY_RESULT);

      const { result } = renderHook(() => useTokenDeploy(WALLET));

      // First deploy
      await act(async () => { await result.current.deploy(VALID_PARAMS); });
      expect(result.current.status).toBe('success');

      // Second deploy after first completes — should succeed cleanly
      await act(async () => { await result.current.deploy(VALID_PARAMS); });
      expect(result.current.status).toBe('success');
      expect(result.current.error).toBeNull();
    });
  });

  describe('9. maxRetries boundary', () => {
    it('canRetry becomes false after exhausting maxRetries', async () => {
      vi.mocked(StellarService.prototype.deployToken).mockRejectedValue(
        new Error('always fails')
      );

      const { result } = renderHook(() =>
        useTokenDeploy(WALLET, { maxRetries: 2, retryDelay: 0 })
      );

      // Initial deploy
      await act(async () => {
        await expect(result.current.deploy(VALID_PARAMS)).rejects.toThrow();
      });
      expect(result.current.canRetry).toBe(true);

      // Retry 1
      await act(async () => {
        await expect(result.current.retry()).rejects.toThrow();
      });
      expect(result.current.retryCount).toBe(1);
      expect(result.current.canRetry).toBe(true);

      // Retry 2 — exhausts maxRetries
      await act(async () => {
        await expect(result.current.retry()).rejects.toThrow();
      });
      expect(result.current.retryCount).toBe(2);

      // Next retry returns null (maxRetries reached)
      let nullResult: any;
      await act(async () => {
        nullResult = await result.current.retry();
      });
      expect(nullResult).toBeNull();
      // canRetry is false — no more retries available
      expect(result.current.canRetry).toBe(false);
      // error is set (either the last deploy error or the maxRetries message)
      expect(result.current.error).not.toBeNull();
    });
  });
});
