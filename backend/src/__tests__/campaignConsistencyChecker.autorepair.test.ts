/**
 * Tests for #1589: Auto-repair functionality for campaign consistency drifts.
 *
 * Verifies that well-understood drift patterns are automatically repaired
 * while ambiguous drifts are properly escalated for manual review.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  CampaignConsistencyChecker,
  type ConsistencyDiff,
  type OnChainCampaignState,
} from '../services/campaignConsistencyChecker';

const mockPrisma = vi.hoisted(() => ({
  campaign: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrisma),
}));

describe('CampaignConsistencyChecker - Auto-Repair', () => {
  let checker: CampaignConsistencyChecker;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    checker = new CampaignConsistencyChecker();
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('autoRepairDrift - safe drifts', () => {
    it('repairs currentAmount drift by syncing with on-chain value', async () => {
      const diff: ConsistencyDiff = {
        campaignId: 1,
        field: 'currentAmount',
        backendValue: BigInt(1000),
        onChainValue: BigInt(1500),
      };

      mockPrisma.campaign.update.mockResolvedValue({
        campaignId: 1,
        currentAmount: BigInt(1500),
      });

      const auditLogs: any[] = [];
      const success = await checker.autoRepairDrift(diff, auditLogs);

      expect(success).toBe(true);
      expect(mockPrisma.campaign.update).toHaveBeenCalledWith({
        where: { campaignId: 1 },
        data: { currentAmount: BigInt(1500) },
      });
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        campaignId: 1,
        field: 'currentAmount',
        beforeValue: BigInt(1000),
        afterValue: BigInt(1500),
        reason: 'Auto-repair: synced with on-chain state',
      });
    });

    it('repairs status drift by syncing with on-chain value', async () => {
      const diff: ConsistencyDiff = {
        campaignId: 2,
        field: 'status',
        backendValue: 'ACTIVE',
        onChainValue: 'COMPLETED',
      };

      mockPrisma.campaign.update.mockResolvedValue({
        campaignId: 2,
        status: 'COMPLETED',
      });

      const auditLogs: any[] = [];
      const success = await checker.autoRepairDrift(diff, auditLogs);

      expect(success).toBe(true);
      expect(mockPrisma.campaign.update).toHaveBeenCalledWith({
        where: { campaignId: 2 },
        data: { status: 'COMPLETED' },
      });
      expect(auditLogs).toHaveLength(1);
    });

    it('repairs executionCount drift by syncing with on-chain value', async () => {
      const diff: ConsistencyDiff = {
        campaignId: 3,
        field: 'executionCount',
        backendValue: 5,
        onChainValue: 7,
      };

      mockPrisma.campaign.update.mockResolvedValue({
        campaignId: 3,
        executionCount: 7,
      });

      const auditLogs: any[] = [];
      const success = await checker.autoRepairDrift(diff, auditLogs);

      expect(success).toBe(true);
      expect(mockPrisma.campaign.update).toHaveBeenCalledWith({
        where: { campaignId: 3 },
        data: { executionCount: 7 },
      });
      expect(auditLogs).toHaveLength(1);
    });
  });

  describe('autoRepairDrift - ambiguous drifts', () => {
    it('escalates existence drift for manual review', async () => {
      const diff: ConsistencyDiff = {
        campaignId: 10,
        field: 'existence',
        backendValue: null,
        onChainValue: 'exists',
      };

      const auditLogs: any[] = [];
      const success = await checker.autoRepairDrift(diff, auditLogs);

      expect(success).toBe(false);
      expect(mockPrisma.campaign.update).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });

    it('escalates targetAmount drift for manual review', async () => {
      const diff: ConsistencyDiff = {
        campaignId: 11,
        field: 'targetAmount',
        backendValue: BigInt(10000),
        onChainValue: BigInt(15000),
      };

      const auditLogs: any[] = [];
      const success = await checker.autoRepairDrift(diff, auditLogs);

      expect(success).toBe(false);
      expect(mockPrisma.campaign.update).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('autoRepairDrift - error handling', () => {
    it('returns false when database update fails', async () => {
      const diff: ConsistencyDiff = {
        campaignId: 4,
        field: 'currentAmount',
        backendValue: BigInt(1000),
        onChainValue: BigInt(2000),
      };

      mockPrisma.campaign.update.mockRejectedValue(new Error('Database error'));

      const auditLogs: any[] = [];
      const success = await checker.autoRepairDrift(diff, auditLogs);

      expect(success).toBe(false);
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('autoRepairDrifts - batch repair', () => {
    it('repairs safe drifts and escalates ambiguous ones', async () => {
      const diffs: ConsistencyDiff[] = [
        {
          campaignId: 20,
          field: 'currentAmount',
          backendValue: BigInt(1000),
          onChainValue: BigInt(2000),
        },
        {
          campaignId: 21,
          field: 'existence',
          backendValue: null,
          onChainValue: 'exists',
        },
        {
          campaignId: 22,
          field: 'status',
          backendValue: 'ACTIVE',
          onChainValue: 'PAUSED',
        },
      ];

      mockPrisma.campaign.update.mockResolvedValue({});

      const auditLogs: any[] = [];
      const result = await checker.autoRepairDrifts(diffs, auditLogs);

      expect(result.repaired).toHaveLength(2);
      expect(result.escalated).toHaveLength(1);
      expect(result.repaired.map(d => d.campaignId)).toContain(20);
      expect(result.repaired.map(d => d.campaignId)).toContain(22);
      expect(result.escalated.map(d => d.campaignId)).toContain(21);
      expect(auditLogs).toHaveLength(2);
    });

    it('returns all audit logs for repaired drifts', async () => {
      const diffs: ConsistencyDiff[] = [
        {
          campaignId: 30,
          field: 'currentAmount',
          backendValue: BigInt(100),
          onChainValue: BigInt(200),
        },
        {
          campaignId: 31,
          field: 'executionCount',
          backendValue: 1,
          onChainValue: 3,
        },
      ];

      mockPrisma.campaign.update.mockResolvedValue({});

      const auditLogs: any[] = [];
      const result = await checker.autoRepairDrifts(diffs, auditLogs);

      expect(result.auditLogs).toHaveLength(2);
      expect(result.auditLogs[0]).toHaveProperty('id');
      expect(result.auditLogs[0]).toHaveProperty('timestamp');
      expect(result.auditLogs.every(log => log.reason === 'Auto-repair: synced with on-chain state')).toBe(true);
    });
  });

  describe('auto-repair classification', () => {
    it('classifies safe drift patterns correctly', async () => {
      const safeDrifts: ConsistencyDiff[] = [
        { campaignId: 1, field: 'currentAmount', backendValue: 100, onChainValue: 200 },
        { campaignId: 2, field: 'status', backendValue: 'A', onChainValue: 'B' },
        { campaignId: 3, field: 'executionCount', backendValue: 1, onChainValue: 2 },
      ];

      mockPrisma.campaign.update.mockResolvedValue({});

      const result = await checker.autoRepairDrifts(safeDrifts);

      expect(result.repaired).toHaveLength(3);
      expect(result.escalated).toHaveLength(0);
    });

    it('classifies ambiguous drift patterns correctly', async () => {
      const ambiguousDrifts: ConsistencyDiff[] = [
        { campaignId: 1, field: 'existence', backendValue: null, onChainValue: 'exists' },
        { campaignId: 2, field: 'targetAmount', backendValue: 1000, onChainValue: 2000 },
      ];

      const result = await checker.autoRepairDrifts(ambiguousDrifts);

      expect(result.repaired).toHaveLength(0);
      expect(result.escalated).toHaveLength(2);
    });
  });

  describe('audit trail creation', () => {
    it('creates detailed audit logs with timestamps', async () => {
      const diff: ConsistencyDiff = {
        campaignId: 50,
        field: 'currentAmount',
        backendValue: BigInt(1000),
        onChainValue: BigInt(5000),
      };

      mockPrisma.campaign.update.mockResolvedValue({});

      const auditLogs: any[] = [];
      const beforeTime = Date.now();
      await checker.autoRepairDrift(diff, auditLogs);
      const afterTime = Date.now();

      expect(auditLogs).toHaveLength(1);
      const log = auditLogs[0];
      expect(log.id).toBeDefined();
      expect(log.campaignId).toBe(50);
      expect(log.field).toBe('currentAmount');
      expect(log.beforeValue).toBe(BigInt(1000));
      expect(log.afterValue).toBe(BigInt(5000));
      expect(log.timestamp.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(log.timestamp.getTime()).toBeLessThanOrEqual(afterTime);
    });
  });
});
