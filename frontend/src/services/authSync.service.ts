/**
 * AuthSyncService — issue #1371
 *
 * Bridges the frontend wallet state and backend JWT session so they never
 * silently desync. Three scenarios are handled:
 *
 * 1. Wallet disconnect  → POST /auth/logout to invalidate the server-side JWT
 * 2. 401 received       → attempt silent re-auth; queue and retry in-flight requests
 * 3. Page refresh with valid JWT but no wallet → set a flag so UI can prompt
 *    reconnect without forcing a full logout
 */

import { apiClient, ApiError } from './apiClient';

// ---------------------------------------------------------------------------
// Token storage helpers (simple wrappers so tests can spy on them)
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'nova_access_token';
const REFRESH_KEY = 'nova_refresh_token';

export const tokenStorage = {
  getAccess: (): string | null => localStorage.getItem(TOKEN_KEY),
  setAccess: (t: string): void => { localStorage.setItem(TOKEN_KEY, t); },
  getRefresh: (): string | null => localStorage.getItem(REFRESH_KEY),
  setRefresh: (t: string): void => { localStorage.setItem(REFRESH_KEY, t); },
  clear: (): void => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

// ---------------------------------------------------------------------------
// AuthSyncService
// ---------------------------------------------------------------------------

type ReauthCallback = () => Promise<void>;

export class AuthSyncService {
  private static _instance: AuthSyncService | null = null;

  /** True when a re-auth is already in progress (prevents parallel attempts). */
  private _reauthInProgress = false;

  /** Queued resolvers waiting for re-auth to complete. */
  private _reauthQueue: Array<(token: string | null) => void> = [];

  /** Registered re-authentication callback (set by wallet connect flow). */
  private _reauthCallback: ReauthCallback | null = null;

  /** True when we detected a valid JWT on load but the wallet is not connected. */
  private _walletReconnectNeeded = false;

  static getInstance(): AuthSyncService {
    if (!AuthSyncService._instance) {
      AuthSyncService._instance = new AuthSyncService();
    }
    return AuthSyncService._instance;
  }

  /** Register the callback that reconnects the wallet and re-issues a JWT. */
  setReauthCallback(cb: ReauthCallback): void {
    this._reauthCallback = cb;
  }

  get walletReconnectNeeded(): boolean {
    return this._walletReconnectNeeded;
  }

  /**
   * Called on page load. If a JWT exists but the wallet is not connected,
   * flag that a wallet reconnect prompt is needed instead of forcing logout.
   */
  onPageLoad(walletConnected: boolean): void {
    const hasToken = Boolean(tokenStorage.getAccess());
    this._walletReconnectNeeded = hasToken && !walletConnected;
  }

  /**
   * Called when the user disconnects their wallet.
   * Invalidates the server-side JWT then clears local tokens.
   */
  async onDisconnect(): Promise<void> {
    try {
      await apiClient.post('/auth/logout');
    } catch {
      // Best-effort — proceed with local cleanup regardless
    }
    tokenStorage.clear();
    this._walletReconnectNeeded = false;
  }

  /**
   * Called when a 401 response is received on any API request.
   * Attempts to re-authenticate silently; returns the new access token on
   * success or null on failure.  Multiple concurrent callers are coalesced
   * into a single re-auth attempt.
   */
  async handleUnauthorized(): Promise<string | null> {
    if (this._reauthInProgress) {
      // Wait for the in-progress re-auth
      return new Promise<string | null>((resolve) => {
        this._reauthQueue.push(resolve);
      });
    }

    this._reauthInProgress = true;

    try {
      // 1. Try silent refresh via refresh token
      const refreshToken = tokenStorage.getRefresh();
      if (refreshToken) {
        const data = await apiClient.post<{ accessToken: string; refreshToken: string }>(
          '/auth/refresh',
          { refreshToken }
        );
        tokenStorage.setAccess(data.accessToken);
        tokenStorage.setRefresh(data.refreshToken);
        this._drainQueue(data.accessToken);
        return data.accessToken;
      }

      // 2. Fall back to wallet re-auth callback if registered
      if (this._reauthCallback) {
        await this._reauthCallback();
        const newToken = tokenStorage.getAccess();
        this._drainQueue(newToken);
        return newToken;
      }

      // 3. Cannot recover — clear tokens and signal failure
      tokenStorage.clear();
      this._walletReconnectNeeded = true;
      this._drainQueue(null);
      return null;
    } catch (err) {
      tokenStorage.clear();
      this._walletReconnectNeeded = true;
      this._drainQueue(null);
      return null;
    } finally {
      this._reauthInProgress = false;
    }
  }

  /** @internal — drain the queue after re-auth completes */
  private _drainQueue(token: string | null): void {
    for (const resolve of this._reauthQueue) {
      resolve(token);
    }
    this._reauthQueue = [];
  }

  /** Reset singleton state (test helper). */
  static _reset(): void {
    AuthSyncService._instance = null;
  }
}

export const authSyncService = AuthSyncService.getInstance();
