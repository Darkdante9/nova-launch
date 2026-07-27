/**
 * Integration tests — AuthSyncService desync scenarios (#1371)
 *
 * Scenario 1: Wallet disconnect → backend session invalidated
 * Scenario 2: 401 received     → re-auth triggered, request retried
 * Scenario 3: Page refresh with valid JWT + no wallet → reconnect prompt, no logout
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthSyncService, tokenStorage } from '../authSync.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock apiClient so we don't make real HTTP calls
vi.mock('../apiClient', () => ({
  apiClient: {
    post: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    constructor(public status: number, public statusText: string, public body: string) {
      super(`${status}`);
    }
  },
}));

import { apiClient } from '../apiClient';
const mockPost = vi.mocked(apiClient.post);

// Stub localStorage
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshService(): AuthSyncService {
  AuthSyncService._reset();
  return AuthSyncService.getInstance();
}

beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  mockPost.mockReset();
  AuthSyncService._reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scenario 1 — Wallet disconnect → backend session invalidated
// ---------------------------------------------------------------------------

describe('Scenario 1: wallet disconnect invalidates backend session', () => {
  it('calls POST /auth/logout on disconnect', async () => {
    mockPost.mockResolvedValue({});
    tokenStorage.setAccess('access-tok');
    tokenStorage.setRefresh('refresh-tok');

    const svc = freshService();
    await svc.onDisconnect();

    expect(mockPost).toHaveBeenCalledWith('/auth/logout');
  });

  it('clears local tokens after disconnect', async () => {
    mockPost.mockResolvedValue({});
    tokenStorage.setAccess('access-tok');
    tokenStorage.setRefresh('refresh-tok');

    const svc = freshService();
    await svc.onDisconnect();

    expect(tokenStorage.getAccess()).toBeNull();
    expect(tokenStorage.getRefresh()).toBeNull();
  });

  it('clears tokens even when logout endpoint throws', async () => {
    mockPost.mockRejectedValue(new Error('network error'));
    tokenStorage.setAccess('access-tok');

    const svc = freshService();
    await svc.onDisconnect();

    expect(tokenStorage.getAccess()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — 401 received → re-auth triggered, original request retried
// ---------------------------------------------------------------------------

describe('Scenario 2: 401 received triggers re-auth and returns new token', () => {
  it('uses refresh token to obtain a new access token', async () => {
    tokenStorage.setRefresh('old-refresh');
    mockPost.mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });

    const svc = freshService();
    const token = await svc.handleUnauthorized();

    expect(mockPost).toHaveBeenCalledWith('/auth/refresh', { refreshToken: 'old-refresh' });
    expect(token).toBe('new-access');
    expect(tokenStorage.getAccess()).toBe('new-access');
    expect(tokenStorage.getRefresh()).toBe('new-refresh');
  });

  it('falls back to reauthCallback when no refresh token', async () => {
    const reauthCb = vi.fn(async () => {
      tokenStorage.setAccess('wallet-reauth-token');
    });

    const svc = freshService();
    svc.setReauthCallback(reauthCb);
    const token = await svc.handleUnauthorized();

    expect(reauthCb).toHaveBeenCalledOnce();
    expect(token).toBe('wallet-reauth-token');
  });

  it('coalesces concurrent 401s into a single re-auth attempt', async () => {
    tokenStorage.setRefresh('rf');
    let resolveRefresh!: (v: unknown) => void;
    mockPost.mockReturnValue(new Promise((res) => { resolveRefresh = res; }));

    const svc = freshService();
    const [p1, p2, p3] = [
      svc.handleUnauthorized(),
      svc.handleUnauthorized(),
      svc.handleUnauthorized(),
    ];

    resolveRefresh({ accessToken: 'tok', refreshToken: 'rf2' });
    const results = await Promise.all([p1, p2, p3]);

    expect(mockPost).toHaveBeenCalledOnce(); // only one refresh call
    expect(results).toEqual(['tok', 'tok', 'tok']);
  });

  it('clears tokens and returns null when both refresh and callback are unavailable', async () => {
    tokenStorage.setAccess('stale');
    const svc = freshService();
    const token = await svc.handleUnauthorized();

    expect(token).toBeNull();
    expect(tokenStorage.getAccess()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Page refresh with JWT + no wallet → reconnect prompt, no logout
// ---------------------------------------------------------------------------

describe('Scenario 3: page refresh with JWT but no wallet', () => {
  it('sets walletReconnectNeeded when JWT present but wallet not connected', () => {
    tokenStorage.setAccess('valid-jwt');
    const svc = freshService();

    svc.onPageLoad(false);

    expect(svc.walletReconnectNeeded).toBe(true);
    // Tokens must NOT be cleared
    expect(tokenStorage.getAccess()).toBe('valid-jwt');
  });

  it('does not set walletReconnectNeeded when wallet is connected', () => {
    tokenStorage.setAccess('valid-jwt');
    const svc = freshService();

    svc.onPageLoad(true);

    expect(svc.walletReconnectNeeded).toBe(false);
  });

  it('does not set walletReconnectNeeded when no JWT exists', () => {
    const svc = freshService();
    svc.onPageLoad(false);
    expect(svc.walletReconnectNeeded).toBe(false);
  });
});
