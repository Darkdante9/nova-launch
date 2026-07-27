import { SequenceNumberCache } from '../sequence-number-cache';

describe('SequenceNumberCache', () => {
  let cache: SequenceNumberCache;

  beforeEach(() => {
    cache = new SequenceNumberCache(300000); // 5 min TTL
  });

  afterEach(() => {
    cache.clear();
  });

  describe('Basic caching operations', () => {
    it('should cache and retrieve sequence number', () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const sequence = '123456789';

      cache.set(accountId, sequence);
      const retrieved = cache.get(accountId);

      expect(retrieved).toBe(sequence);
    });

    it('should return null for uncached account', () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const retrieved = cache.get(accountId);

      expect(retrieved).toBeNull();
    });

    it('should invalidate cached sequence', () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const sequence = '123456789';

      cache.set(accountId, sequence);
      cache.invalidate(accountId);
      const retrieved = cache.get(accountId);

      expect(retrieved).toBeNull();
    });

    it('should increment cached sequence', () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const initialSequence = '123456789';

      cache.set(accountId, initialSequence);
      cache.increment(accountId);
      const incremented = cache.get(accountId);

      expect(incremented).toBe('123456790');
    });

    it('should handle BigInt sequence numbers', () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const largeSequence = '999999999999999999';

      cache.set(accountId, largeSequence);
      cache.increment(accountId);
      const incremented = cache.get(accountId);

      expect(incremented).toBe('1000000000000000000');
    });
  });

  describe('Cache expiration', () => {
    it('should expire cached entries after TTL', async () => {
      const shortTtlCache = new SequenceNumberCache(100); // 100ms TTL
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const sequence = '123456789';

      shortTtlCache.set(accountId, sequence);

      // Should be cached immediately
      expect(shortTtlCache.get(accountId)).toBe(sequence);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should be expired
      expect(shortTtlCache.get(accountId)).toBeNull();
    });

    it('should not expire entries before TTL', async () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const sequence = '123456789';

      cache.set(accountId, sequence);

      // Wait 50ms (well before 5 min TTL)
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(cache.get(accountId)).toBe(sequence);
    });
  });

  describe('Account locking', () => {
    it('should acquire and release lock for single account', async () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      const releaseLock = await cache.acquireLock(accountId);
      const stats = cache.getStats();

      expect(stats.accounts.find((a) => a.accountId === accountId)?.locked).toBe(true);

      releaseLock();

      const statsAfter = cache.getStats();
      expect(statsAfter.accounts.find((a) => a.accountId === accountId)?.locked).toBe(false);
    });

    it('should serialize lock requests for same account', async () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const operations: number[] = [];

      // First operation acquires lock
      const promise1 = cache.acquireLock(accountId).then(async (release) => {
        operations.push(1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        operations.push(2);
        release();
      });

      // Second operation waits for lock
      const promise2 = cache.acquireLock(accountId).then(async (release) => {
        operations.push(3);
        await new Promise((resolve) => setTimeout(resolve, 50));
        operations.push(4);
        release();
      });

      await Promise.all([promise1, promise2]);

      // Operations should be serialized: 1, 2, 3, 4
      expect(operations).toEqual([1, 2, 3, 4]);
    });

    it('should allow concurrent locks for different accounts', async () => {
      const accountId1 = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const accountId2 = 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';
      const operations: number[] = [];

      // Both operations can run concurrently
      const promise1 = cache.acquireLock(accountId1).then(async (release) => {
        operations.push(1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        operations.push(2);
        release();
      });

      const promise2 = cache.acquireLock(accountId2).then(async (release) => {
        operations.push(3);
        await new Promise((resolve) => setTimeout(resolve, 50));
        operations.push(4);
        release();
      });

      await Promise.all([promise1, promise2]);

      // Operations can interleave
      expect(operations).toContain(1);
      expect(operations).toContain(2);
      expect(operations).toContain(3);
      expect(operations).toContain(4);
    });
  });

  describe('Sequence mismatch detection', () => {
    it('should detect TX_BAD_SEQ error code', () => {
      const error = { code: 'TX_BAD_SEQ', message: 'Bad sequence' };
      expect((cache as any).isSequenceMismatchError(error)).toBe(true);
    });

    it('should detect bad_seq in message', () => {
      const error = { message: 'Transaction failed: bad_seq' };
      expect((cache as any).isSequenceMismatchError(error)).toBe(true);
    });

    it('should detect sequence mismatch in message', () => {
      const error = { message: 'Sequence mismatch detected' };
      expect((cache as any).isSequenceMismatchError(error)).toBe(true);
    });

    it('should detect tx_bad_seq in response data', () => {
      const error = {
        message: 'Transaction failed',
        response: {
          data: {
            error: 'tx_bad_seq',
          },
        },
      };
      expect((cache as any).isSequenceMismatchError(error)).toBe(true);
    });

    it('should not detect non-sequence errors', () => {
      const error = { message: 'Network timeout' };
      expect((cache as any).isSequenceMismatchError(error)).toBe(false);
    });
  });

  describe('executeWithSequenceManagement', () => {
    it('should use cached sequence on first attempt', async () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const cachedSequence = '123456789';

      cache.set(accountId, cachedSequence);

      const fetchAccount = jest.fn();
      const buildAndSubmit = jest.fn().mockResolvedValue({ hash: 'tx123' });

      await cache.executeWithSequenceManagement(
        accountId,
        fetchAccount,
        buildAndSubmit
      );

      // Should not fetch from network
      expect(fetchAccount).not.toHaveBeenCalled();

      // Should use cached sequence
      expect(buildAndSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          sequenceNumber: expect.any(Function),
        })
      );

      const account = buildAndSubmit.mock.calls[0][0];
      expect(account.sequenceNumber()).toBe(cachedSequence);
    });

    it('should fetch from network if no cache', async () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const networkSequence = '987654321';

      const fetchAccount = jest.fn().mockResolvedValue({
        accountId: () => accountId,
        sequenceNumber: () => networkSequence,
      });
      const buildAndSubmit = jest.fn().mockResolvedValue({ hash: 'tx123' });

      await cache.executeWithSequenceManagement(
        accountId,
        fetchAccount,
        buildAndSubmit
      );

      // Should fetch from network
      expect(fetchAccount).toHaveBeenCalledTimes(1);

      // Should cache the sequence
      expect(cache.get(accountId)).toBe(networkSequence);
    });

    it('should increment sequence on success', async () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const initialSequence = '100';

      cache.set(accountId, initialSequence);

      const fetchAccount = jest.fn();
      const buildAndSubmit = jest.fn().mockResolvedValue({ hash: 'tx123' });

      await cache.executeWithSequenceManagement(
        accountId,
        fetchAccount,
        buildAndSubmit
      );

      // Should increment cached sequence
      expect(cache.get(accountId)).toBe('101');
    });

    it('should refresh and retry on sequence mismatch', async () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const staleSequence = '100';
      const freshSequence = '105';

      cache.set(accountId, staleSequence);

      const fetchAccount = jest.fn().mockResolvedValue({
        accountId: () => accountId,
        sequenceNumber: () => freshSequence,
      });

      const buildAndSubmit = jest
        .fn()
        .mockRejectedValueOnce({ message: 'Transaction failed: bad_seq' })
        .mockResolvedValueOnce({ hash: 'tx123' });

      const result = await cache.executeWithSequenceManagement(
        accountId,
        fetchAccount,
        buildAndSubmit
      );

      // Should fetch fresh sequence after mismatch
      expect(fetchAccount).toHaveBeenCalledTimes(1);

      // Should have retried with fresh sequence
      expect(buildAndSubmit).toHaveBeenCalledTimes(2);

      // Should increment the fresh sequence
      expect(cache.get(accountId)).toBe('106');

      expect(result).toEqual({ hash: 'tx123' });
    });

    it('should propagate non-sequence errors', async () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      cache.set(accountId, '100');

      const fetchAccount = jest.fn();
      const buildAndSubmit = jest.fn().mockRejectedValue({ message: 'Network timeout' });

      await expect(
        cache.executeWithSequenceManagement(accountId, fetchAccount, buildAndSubmit)
      ).rejects.toEqual({ message: 'Network timeout' });

      // Should not fetch fresh sequence
      expect(fetchAccount).not.toHaveBeenCalled();
    });

    it('should serialize concurrent transactions for same account', async () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      cache.set(accountId, '100');

      const submissions: string[] = [];
      const buildAndSubmit = jest.fn().mockImplementation(async (account) => {
        const seq = account.sequenceNumber();
        submissions.push(seq);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { hash: `tx-${seq}` };
      });

      const fetchAccount = jest.fn();

      // Submit 3 transactions concurrently
      const promises = [
        cache.executeWithSequenceManagement(accountId, fetchAccount, buildAndSubmit),
        cache.executeWithSequenceManagement(accountId, fetchAccount, buildAndSubmit),
        cache.executeWithSequenceManagement(accountId, fetchAccount, buildAndSubmit),
      ];

      await Promise.all(promises);

      // Sequences should be serialized: 100, 101, 102
      expect(submissions).toEqual(['100', '101', '102']);

      // Final cached sequence should be 103
      expect(cache.get(accountId)).toBe('103');
    });
  });

  describe('Statistics', () => {
    it('should return cache statistics', () => {
      const accountId1 = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const accountId2 = 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';

      cache.set(accountId1, '100');
      cache.set(accountId2, '200');

      const stats = cache.getStats();

      expect(stats.size).toBe(2);
      expect(stats.accounts).toHaveLength(2);
      expect(stats.accounts.find((a) => a.accountId === accountId1)?.sequence).toBe('100');
      expect(stats.accounts.find((a) => a.accountId === accountId2)?.sequence).toBe('200');
    });

    it('should include age and lock status in statistics', async () => {
      const accountId = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

      cache.set(accountId, '100');
      const releaseLock = await cache.acquireLock(accountId);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const stats = cache.getStats();
      const accountStats = stats.accounts.find((a) => a.accountId === accountId);

      expect(accountStats?.locked).toBe(true);
      expect(accountStats?.age).toBeGreaterThanOrEqual(50);

      releaseLock();
    });
  });

  describe('Clear', () => {
    it('should clear all cached sequences', () => {
      const accountId1 = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
      const accountId2 = 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';

      cache.set(accountId1, '100');
      cache.set(accountId2, '200');

      cache.clear();

      expect(cache.get(accountId1)).toBeNull();
      expect(cache.get(accountId2)).toBeNull();
      expect(cache.getStats().size).toBe(0);
    });
  });

  // ── Ledger-close invalidation ────────────────────────────────────────────

  describe('Ledger-close subscription', () => {
    /** Build a minimal mock Stellar server whose stream fires once. */
    function makeMockServer(triggerImmediately = true): {
      server: any;
      fireLedger: () => void;
    } {
      let onmessageHandler: ((ledger: any) => void) | null = null;

      const streamFn = jest.fn((opts: { onmessage: (l: any) => void }) => {
        onmessageHandler = opts.onmessage;
        if (triggerImmediately) {
          setImmediate(() => opts.onmessage({ sequence: 1 }));
        }
        return jest.fn(); // stop fn
      });

      const server = {
        ledgers: () => ({
          order: () => ({
            cursor: () => ({
              stream: streamFn,
            }),
          }),
        }),
        loadAccount: jest.fn(),
      };

      return {
        server,
        fireLedger: () => onmessageHandler?.({ sequence: 99 }),
      };
    }

    afterEach(() => {
      cache.stopLedgerSubscription();
    });

    it('cache miss (Horizon fetch) — get returns null for uncached account', () => {
      const accountId = 'GABC';
      expect(cache.get(accountId)).toBeNull();
    });

    it('cache hit — get returns cached value before any ledger event', () => {
      const accountId = 'GABC';
      cache.set(accountId, '42');
      expect(cache.get(accountId)).toBe('42');
    });

    it('ledger-close invalidation — entry is evicted on ledger close', async () => {
      const accountId = 'GABC';
      cache.set(accountId, '42');

      const { server, fireLedger } = makeMockServer(false);
      cache.startLedgerSubscription(server, new Set([accountId]));

      fireLedger();
      // Allow microtasks/setImmediate to run
      await new Promise((r) => setImmediate(r));

      expect(cache.get(accountId)).toBeNull();
    });

    it('stale_evictions counter increments on ledger-close eviction', async () => {
      const accountId = 'GABC';
      cache.set(accountId, '10');

      expect(cache.staleEvictions).toBe(0);

      const { server, fireLedger } = makeMockServer(false);
      cache.startLedgerSubscription(server, new Set([accountId]));
      fireLedger();
      await new Promise((r) => setImmediate(r));

      expect(cache.staleEvictions).toBe(1);
    });

    it('stale_evictions counter increments on TTL-based expiry', async () => {
      const shortTtlCache = new SequenceNumberCache(50); // 50 ms TTL
      const accountId = 'GABC';
      shortTtlCache.set(accountId, '5');

      // Wait for TTL to elapse then trigger a get() which calls _evictStale
      await new Promise((r) => setTimeout(r, 80));
      expect(shortTtlCache.get(accountId)).toBeNull();
      expect(shortTtlCache.staleEvictions).toBe(1);

      shortTtlCache.stopLedgerSubscription();
    });

    it('stopLedgerSubscription prevents further evictions', async () => {
      const accountId = 'GABC';
      cache.set(accountId, '7');

      const { server, fireLedger } = makeMockServer(false);
      cache.startLedgerSubscription(server, new Set([accountId]));
      cache.stopLedgerSubscription();

      // Re-add after stopping, then fire ledger — should NOT be evicted
      cache.set(accountId, '7');
      fireLedger();
      await new Promise((r) => setImmediate(r));

      expect(cache.get(accountId)).toBe('7');
    });

    it('getStats includes staleEvictions count', async () => {
      const accountId = 'GABC';
      cache.set(accountId, '3');

      const { server, fireLedger } = makeMockServer(false);
      cache.startLedgerSubscription(server, new Set([accountId]));
      fireLedger();
      await new Promise((r) => setImmediate(r));

      const stats = cache.getStats();
      expect(stats.staleEvictions).toBe(1);
    });
  });
});
