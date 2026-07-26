/**
 * Tests for StreamMetadataService
 *
 * Verifies that stream metadata is kept in sync with on-chain state, that
 * financial invariants (amount, creator, recipient, schedule) are preserved
 * across updates, and that invalid or unauthorized updates are rejected.
 *
 * All tests use an in-memory mock of Prisma — no real database required.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamMetadataService } from '../services/streamMetadataService';

// ---------------------------------------------------------------------------
// In-memory stream store + Prisma mock
// ---------------------------------------------------------------------------

type StreamRow = {
  id: string;
  streamId: number;
  creator: string;
  recipient: string;
  amount: bigint;
  metadata: string | null;
  status: string;
  txHash: string;
  createdAt: Date;
  claimedAt: Date | null;
  cancelledAt: Date | null;
};

let streamStore: Map<number, StreamRow>;

function makeStream(overrides: Partial<StreamRow> = {}): StreamRow {
  return {
    id: 'mock-id',
    streamId: 1,
    creator: 'GCREATOR_ADDRESS',
    recipient: 'GRECIPIENT_ADDRESS',
    amount: BigInt('10000000000'),
    metadata: null,
    status: 'CREATED',
    txHash: '0xabc',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    claimedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

let findUniqueMock: ReturnType<typeof vi.fn>;
let updateMock: ReturnType<typeof vi.fn>;
let findManyMock: ReturnType<typeof vi.fn>;

function buildMockPrisma() {
  findUniqueMock = vi.fn(async ({ where, select }: any) => {
    const row = streamStore.get(where.streamId);
    if (!row) return null;
    if (select) {
      // Return only selected fields
      const result: any = {};
      for (const key of Object.keys(select)) {
        result[key] = (row as any)[key];
      }
      return result;
    }
    return row;
  });

  updateMock = vi.fn(async ({ where, data }: any) => {
    const row = streamStore.get(where.streamId);
    if (!row) throw new Error(`Stream ${where.streamId} not found`);
    const updated = { ...row, ...data };
    streamStore.set(where.streamId, updated);
    return updated;
  });

  findManyMock = vi.fn(async ({ where }: any) => {
    const results: StreamRow[] = [];
    for (const row of streamStore.values()) {
      let match = true;
      if (where.creator && row.creator !== where.creator) match = false;
      if (where.metadata?.not === null && row.metadata === null) match = false;
      if (where.metadata === null && row.metadata !== null) match = false;
      if (match) results.push(row);
    }
    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  });

  return {
    stream: {
      findUnique: findUniqueMock,
      update: updateMock,
      findMany: findManyMock,
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('StreamMetadataService', () => {
  let service: StreamMetadataService;

  beforeEach(() => {
    streamStore = new Map();
    const mockPrisma = buildMockPrisma();
    service = new StreamMetadataService(mockPrisma as any);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Metadata created (set) on stream-created event
  //    → upsert a stream with initial metadata, then read it back
  // ──────────────────────────────────────────────────────────────────────────
  describe('metadata created on stream-created event', () => {
    it('stores metadata when a stream is seeded with initial metadata', async () => {
      streamStore.set(1, makeStream({ streamId: 1, metadata: 'ipfs://QmInitial' }));

      const meta = await service.getMetadata(1);
      expect(meta).toBe('ipfs://QmInitial');
    });

    it('stores null when stream is created without metadata', async () => {
      streamStore.set(2, makeStream({ streamId: 2, metadata: null }));

      const meta = await service.getMetadata(2);
      expect(meta).toBeNull();
    });

    it('getMetadata throws when stream does not exist', async () => {
      await expect(service.getMetadata(999)).rejects.toThrow('999 not found');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Metadata updated on rate-change event
  //    (represented here as a metadata string update by the creator)
  // ──────────────────────────────────────────────────────────────────────────
  describe('metadata updated on rate-change event', () => {
    beforeEach(() => {
      streamStore.set(10, makeStream({ streamId: 10, metadata: 'ipfs://QmOld' }));
    });

    it('updates metadata to a new IPFS URI', async () => {
      const result = await service.updateMetadata(10, 'GCREATOR_ADDRESS', 'ipfs://QmNew');
      expect(result.metadata).toBe('ipfs://QmNew');
    });

    it('records the updated value in the store', async () => {
      await service.updateMetadata(10, 'GCREATOR_ADDRESS', 'ipfs://QmUpdated');
      const meta = await service.getMetadata(10);
      expect(meta).toBe('ipfs://QmUpdated');
    });

    it('clears metadata when new value is null', async () => {
      await service.updateMetadata(10, 'GCREATOR_ADDRESS', null);
      const meta = await service.getMetadata(10);
      expect(meta).toBeNull();
    });

    it('preserves financial terms after update — amount unchanged', async () => {
      const before = streamStore.get(10)!;
      await service.updateMetadata(10, 'GCREATOR_ADDRESS', 'ipfs://QmNew');
      const after = streamStore.get(10)!;
      expect(after.amount).toBe(before.amount);
    });

    it('preserves financial terms after update — creator unchanged', async () => {
      const before = streamStore.get(10)!;
      await service.updateMetadata(10, 'GCREATOR_ADDRESS', 'ipfs://QmNew');
      const after = streamStore.get(10)!;
      expect(after.creator).toBe(before.creator);
    });

    it('preserves financial terms after update — recipient unchanged', async () => {
      const before = streamStore.get(10)!;
      await service.updateMetadata(10, 'GCREATOR_ADDRESS', 'ipfs://QmNew');
      const after = streamStore.get(10)!;
      expect(after.recipient).toBe(before.recipient);
    });

    it('preserves financial terms after update — createdAt unchanged', async () => {
      const before = streamStore.get(10)!;
      await service.updateMetadata(10, 'GCREATOR_ADDRESS', 'ipfs://QmNew');
      const after = streamStore.get(10)!;
      expect(after.createdAt).toEqual(before.createdAt);
    });

    it('calls prisma.stream.update exactly once', async () => {
      await service.updateMetadata(10, 'GCREATOR_ADDRESS', 'ipfs://QmNew');
      expect(updateMock).toHaveBeenCalledOnce();
    });

    it('passes the correct streamId to prisma.stream.update', async () => {
      await service.updateMetadata(10, 'GCREATOR_ADDRESS', 'ipfs://QmNew');
      const call = updateMock.mock.calls[0][0];
      expect(call.where.streamId).toBe(10);
      expect(call.data.metadata).toBe('ipfs://QmNew');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Stale-metadata-overwrite guard
  //    → an update event referencing an unknown stream must be rejected
  // ──────────────────────────────────────────────────────────────────────────
  describe('stale-metadata-overwrite guard', () => {
    it('rejects updateMetadata for a stream that does not exist', async () => {
      // Store is empty — stream 42 was never created
      await expect(
        service.updateMetadata(42, 'GCREATOR_ADDRESS', 'ipfs://QmStale'),
      ).rejects.toThrow('42 not found');
    });

    it('does not call prisma.stream.update when the stream is missing', async () => {
      try {
        await service.updateMetadata(42, 'GCREATOR_ADDRESS', 'ipfs://QmStale');
      } catch {
        // expected
      }
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('rejects updateMetadata by a non-creator caller', async () => {
      streamStore.set(20, makeStream({ streamId: 20 }));

      await expect(
        service.updateMetadata(20, 'GINTRUDER_ADDRESS', 'ipfs://QmBad'),
      ).rejects.toThrow('creator');
    });

    it('does not modify the stream when an unauthorized update is attempted', async () => {
      streamStore.set(21, makeStream({ streamId: 21, metadata: 'ipfs://QmOriginal' }));

      try {
        await service.updateMetadata(21, 'GINTRUDER_ADDRESS', 'ipfs://QmBad');
      } catch {
        // expected
      }

      const row = streamStore.get(21)!;
      expect(row.metadata).toBe('ipfs://QmOriginal');
    });

    it('rejects empty-string metadata (stale event with blank payload)', async () => {
      streamStore.set(22, makeStream({ streamId: 22 }));

      await expect(
        service.updateMetadata(22, 'GCREATOR_ADDRESS', ''),
      ).rejects.toThrow('empty');
    });

    it('rejects metadata exceeding 512 characters', async () => {
      streamStore.set(23, makeStream({ streamId: 23 }));
      const oversized = 'x'.repeat(513);

      await expect(
        service.updateMetadata(23, 'GCREATOR_ADDRESS', oversized),
      ).rejects.toThrow('512');
    });

    it('accepts metadata of exactly 512 characters', async () => {
      streamStore.set(24, makeStream({ streamId: 24 }));
      const maxLen = 'x'.repeat(512);

      const result = await service.updateMetadata(24, 'GCREATOR_ADDRESS', maxLen);
      expect(result.metadata).toBe(maxLen);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Batch validation helper
  // ──────────────────────────────────────────────────────────────────────────
  describe('validateBatchUpdates', () => {
    beforeEach(() => {
      streamStore.set(30, makeStream({ streamId: 30 }));
      streamStore.set(31, makeStream({ streamId: 31 }));
    });

    it('returns valid=true for well-formed updates by the creator', async () => {
      const results = await service.validateBatchUpdates([
        { streamId: 30, creator: 'GCREATOR_ADDRESS', newMetadata: 'ipfs://Qm30' },
        { streamId: 31, creator: 'GCREATOR_ADDRESS', newMetadata: 'ipfs://Qm31' },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ streamId: 30, valid: true });
      expect(results[1]).toEqual({ streamId: 31, valid: true });
    });

    it('returns valid=false with error when stream is missing', async () => {
      const results = await service.validateBatchUpdates([
        { streamId: 999, creator: 'GCREATOR_ADDRESS', newMetadata: 'ipfs://Qm999' },
      ]);

      expect(results[0].valid).toBe(false);
      expect(results[0].error).toMatch(/not found/i);
    });

    it('returns valid=false when caller is not the creator', async () => {
      const results = await service.validateBatchUpdates([
        { streamId: 30, creator: 'GINTRUDER_ADDRESS', newMetadata: 'ipfs://QmBad' },
      ]);

      expect(results[0].valid).toBe(false);
      expect(results[0].error).toMatch(/unauthorized/i);
    });

    it('returns valid=false for empty-string metadata', async () => {
      const results = await service.validateBatchUpdates([
        { streamId: 30, creator: 'GCREATOR_ADDRESS', newMetadata: '' },
      ]);

      expect(results[0].valid).toBe(false);
      expect(results[0].error).toBeDefined();
    });

    it('handles mixed valid and invalid entries independently', async () => {
      const results = await service.validateBatchUpdates([
        { streamId: 30, creator: 'GCREATOR_ADDRESS', newMetadata: 'ipfs://valid' },
        { streamId: 31, creator: 'GINTRUDER_ADDRESS', newMetadata: 'ipfs://bad' },
        { streamId: 999, creator: 'GCREATOR_ADDRESS', newMetadata: 'ipfs://missing' },
      ]);

      expect(results[0].valid).toBe(true);
      expect(results[1].valid).toBe(false);
      expect(results[2].valid).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. getStreamsByCreator
  // ──────────────────────────────────────────────────────────────────────────
  describe('getStreamsByCreator', () => {
    beforeEach(() => {
      streamStore.set(40, makeStream({ streamId: 40, creator: 'GCREATOR_A', metadata: 'ipfs://Qm40' }));
      streamStore.set(41, makeStream({ streamId: 41, creator: 'GCREATOR_A', metadata: null }));
      streamStore.set(42, makeStream({ streamId: 42, creator: 'GCREATOR_B', metadata: 'ipfs://Qm42' }));
    });

    it('returns all streams for a creator when hasMetadata is not filtered', async () => {
      const results = await service.getStreamsByCreator('GCREATOR_A');
      expect(results).toHaveLength(2);
    });

    it('returns only streams with metadata when hasMetadata=true', async () => {
      const results = await service.getStreamsByCreator('GCREATOR_A', true);
      expect(results).toHaveLength(1);
      expect(results[0].streamId).toBe(40);
    });

    it('returns only streams without metadata when hasMetadata=false', async () => {
      const results = await service.getStreamsByCreator('GCREATOR_A', false);
      expect(results).toHaveLength(1);
      expect(results[0].streamId).toBe(41);
    });

    it('returns empty array for an unknown creator', async () => {
      const results = await service.getStreamsByCreator('GUNKNOWN');
      expect(results).toHaveLength(0);
    });

    it('does not leak streams belonging to a different creator', async () => {
      const results = await service.getStreamsByCreator('GCREATOR_A');
      const streamIds = results.map((r: any) => r.streamId);
      expect(streamIds).not.toContain(42);
    });
  });
});
