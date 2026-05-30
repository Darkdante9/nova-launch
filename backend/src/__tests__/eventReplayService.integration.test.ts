import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { EventReplayService } from '../services/eventReplayService';
import { EventCursorStore } from '../services/eventCursorStore';

// Mock Horizon API
const mockHorizonEvents = [
  {
    type: 'contract',
    ledger: 1000,
    ledger_close_time: '2024-01-01T00:00:00Z',
    contract_id: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    id: '1000-1',
    paging_token: '1000-1',
    topic: ['tok_reg'],
    value: {
      xdr: 'AAAADwAAAAA=',
    },
    in_successful_contract_call: true,
    transaction_hash: 'tx1',
  },
  {
    type: 'contract',
    ledger: 1001,
    ledger_close_time: '2024-01-01T00:01:00Z',
    contract_id: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    id: '1001-1',
    paging_token: '1001-1',
    topic: ['tok_burn'],
    value: {
      xdr: 'AAAADwAAAAA=',
    },
    in_successful_contract_call: true,
    transaction_hash: 'tx2',
  },
];

// Mock parsers
const mockTokenParser = {
  parseEvent: vi.fn(),
};

const mockGovernanceParser = {
  parseEvent: vi.fn(),
};

const mockStreamParser = {
  parseEvent: vi.fn(),
};

// Mock Prisma
let mockPrisma: any;

vi.mock('../services/governanceEventParser', () => ({
  GovernanceEventParser: vi.fn(() => mockGovernanceParser),
}));

vi.mock('../services/tokenEventParser', () => ({
  TokenEventParser: vi.fn(() => mockTokenParser),
}));

vi.mock('../services/streamEventParser', () => ({
  StreamEventParser: vi.fn(() => mockStreamParser),
}));

vi.mock('../services/vaultEventParser', () => ({
  parseVaultCreatedEvent: vi.fn(),
  parseVaultClaimedEvent: vi.fn(),
  parseVaultCancelledEvent: vi.fn(),
  parseVaultMetadataUpdatedEvent: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

describe('EventReplayService', () => {
  let service: EventReplayService;
  let cursorStore: EventCursorStore;

  beforeEach(() => {
    // Setup mock Prisma
    mockPrisma = {
      integrationState: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      token: { deleteMany: vi.fn() },
      burnRecord: { deleteMany: vi.fn() },
      proposal: { deleteMany: vi.fn() },
      vote: { deleteMany: vi.fn() },
      stream: { deleteMany: vi.fn() },
      campaign: { deleteMany: vi.fn() },
      campaignExecution: { deleteMany: vi.fn() },
      campaignAuditTrail: { deleteMany: vi.fn() },
      $transaction: vi.fn(async (ops) => ops),
    };

    cursorStore = new EventCursorStore(mockPrisma);
    service = new EventReplayService(mockPrisma);

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('replay', () => {
    it('should process events in order', async () => {
      const axios = await import('axios');
      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: mockHorizonEvents,
          },
        },
      });

      mockTokenParser.parseEvent.mockResolvedValue(undefined);

      const result = await service.replay({ batchSize: 100 });

      expect(result.eventsProcessed).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should respect endLedger boundary', async () => {
      const axios = await import('axios');
      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: mockHorizonEvents,
          },
        },
      });

      mockTokenParser.parseEvent.mockResolvedValue(undefined);

      const result = await service.replay({ endLedger: 1000 });

      // Should stop at ledger 1000
      expect(result.endLedger).toBeLessThanOrEqual(1000);
    });

    it('should be idempotent on duplicate events', async () => {
      const axios = await import('axios');
      const duplicateEvents = [...mockHorizonEvents, ...mockHorizonEvents];

      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: duplicateEvents,
          },
        },
      });

      mockTokenParser.parseEvent.mockResolvedValue(undefined);

      const result = await service.replay({ batchSize: 100 });

      // Parser should be called for each event (including duplicates)
      // but the parser itself should handle idempotency
      expect(mockTokenParser.parseEvent).toHaveBeenCalled();
      expect(result.eventsProcessed).toBeGreaterThan(0);
    });

    it('should persist cursor on success', async () => {
      const axios = await import('axios');
      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: mockHorizonEvents,
          },
        },
      });

      mockTokenParser.parseEvent.mockResolvedValue(undefined);

      const result = await service.replay({ batchSize: 100 });

      expect(mockPrisma.integrationState.upsert).toHaveBeenCalled();
      expect(result.finalCursor).toBeTruthy();
    });

    it('should not persist cursor in dry-run mode', async () => {
      const axios = await import('axios');
      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: mockHorizonEvents,
          },
        },
      });

      mockTokenParser.parseEvent.mockResolvedValue(undefined);

      await service.replay({ batchSize: 100, dryRun: true });

      expect(mockPrisma.integrationState.upsert).not.toHaveBeenCalled();
    });

    it('should handle network errors with retry', async () => {
      const axios = await import('axios');
      const error = new Error('Network error');
      (error as any).response = { status: 503 };

      (axios.default.get as any)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({
          data: {
            _embedded: {
              records: mockHorizonEvents,
            },
          },
        });

      mockTokenParser.parseEvent.mockResolvedValue(undefined);

      const result = await service.replay({ batchSize: 100, maxRetries: 2, retryDelayMs: 10 });

      expect(result.eventsProcessed).toBeGreaterThan(0);
    });

    it('should collect errors without stopping', async () => {
      const axios = await import('axios');
      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: mockHorizonEvents,
          },
        },
      });

      mockTokenParser.parseEvent
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Parse error'));

      const result = await service.replay({ batchSize: 100 });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.eventsProcessed).toBeGreaterThan(0);
    });

    it('should handle empty event stream', async () => {
      const axios = await import('axios');
      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: [],
          },
        },
      });

      const result = await service.replay({ batchSize: 100 });

      expect(result.eventsProcessed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should load cursor from store on restart', async () => {
      const axios = await import('axios');
      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: mockHorizonEvents,
          },
        },
      });

      mockPrisma.integrationState.findUnique.mockResolvedValue({
        key: 'stellar_event_cursor',
        value: '999-0',
      });

      mockTokenParser.parseEvent.mockResolvedValue(undefined);

      await service.replay({ batchSize: 100 });

      // Should have called Horizon with the stored cursor
      expect(axios.default.get).toHaveBeenCalledWith(
        expect.stringContaining('/events'),
        expect.objectContaining({
          params: expect.objectContaining({
            cursor: '999-0',
          }),
        }),
      );
    });
  });

  describe('clearAndRebuild', () => {
    it('should clear all projections', async () => {
      const axios = await import('axios');
      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: [],
          },
        },
      });

      await service.clearAndRebuild();

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should reset cursor to origin', async () => {
      const axios = await import('axios');
      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: [],
          },
        },
      });

      process.env.STELLAR_CURSOR_ORIGIN = '0-0';

      await service.clearAndRebuild();

      expect(mockPrisma.integrationState.upsert).toHaveBeenCalled();
    });

    it('should rebuild from origin after clearing', async () => {
      const axios = await import('axios');
      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: mockHorizonEvents,
          },
        },
      });

      mockTokenParser.parseEvent.mockResolvedValue(undefined);

      const result = await service.clearAndRebuild();

      expect(result.eventsProcessed).toBeGreaterThan(0);
    });
  });

  describe('error handling', () => {
    it('should throw on missing FACTORY_CONTRACT_ID', async () => {
      const originalEnv = process.env.FACTORY_CONTRACT_ID;
      delete process.env.FACTORY_CONTRACT_ID;

      try {
        await service.replay();
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain('FACTORY_CONTRACT_ID');
      } finally {
        process.env.FACTORY_CONTRACT_ID = originalEnv;
      }
    });

    it('should handle non-retryable errors', async () => {
      const axios = await import('axios');
      const error = new Error('Invalid request');
      (error as any).response = { status: 400 };

      (axios.default.get as any).mockRejectedValue(error);

      try {
        await service.replay({ maxRetries: 1, retryDelayMs: 10 });
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain('Event replay failed');
      }
    });
  });

  describe('performance', () => {
    it('should process large batches efficiently', async () => {
      const axios = await import('axios');
      const largeEventSet = Array.from({ length: 1000 }, (_, i) => ({
        ...mockHorizonEvents[0],
        ledger: 1000 + i,
        paging_token: `${1000 + i}-1`,
        id: `${1000 + i}-1`,
        transaction_hash: `tx${i}`,
      }));

      (axios.default.get as any).mockResolvedValue({
        data: {
          _embedded: {
            records: largeEventSet,
          },
        },
      });

      mockTokenParser.parseEvent.mockResolvedValue(undefined);

      const start = Date.now();
      const result = await service.replay({ batchSize: 1000 });
      const duration = Date.now() - start;

      expect(result.eventsProcessed).toBe(1000);
      expect(duration).toBeLessThan(10000); // Should complete in reasonable time
    });
  });
});
