/**
 * Concurrency tests: Distributed lock idempotency for campaign execution steps.
 *
 * Scenarios:
 *   L1  Second concurrent request returns 202 PROCESSING while first holds the lock
 *   L2  First request completes successfully (200) when it holds the lock
 *   L3  Lock is released after successful execution (third request can proceed)
 *   L4  Lock is released after a failed execution (error path) — no lock leakage
 *   L5  Redis unavailable → fail open, request proceeds without lock
 *   L6  Multiple campaigns do not interfere with each other's locks
 *
 * The test mocks both Prisma and the lock module so no live Redis or DB is needed.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Hoist mock factories so they are available before module imports
// ---------------------------------------------------------------------------
const {
  mockFindUnique,
  mockStepUpdate,
  mockCampaignUpdate,
  mockAcquireStepLock,
  mockReleaseStepLock,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockStepUpdate: vi.fn(),
  mockCampaignUpdate: vi.fn(),
  mockAcquireStepLock: vi.fn(),
  mockReleaseStepLock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock PrismaClient
// ---------------------------------------------------------------------------
vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => ({
    buybackCampaign: {
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: mockFindUnique,
      update: mockCampaignUpdate,
      count: vi.fn().mockResolvedValue(0),
    },
    buybackStep: {
      update: mockStepUpdate,
    },
  })),
}));

// ---------------------------------------------------------------------------
// Mock the lock module
// ---------------------------------------------------------------------------
vi.mock('../lib/lock', () => ({
  acquireStepLock: (...args: unknown[]) => mockAcquireStepLock(...args),
  releaseStepLock: (...args: unknown[]) => mockReleaseStepLock(...args),
  STEP_LOCK_TTL_MS: 30_000,
  stepLockKey: (campaignId: unknown, stepNumber: unknown) =>
    `campaign_step_lock:${campaignId}:${stepNumber}`,
}));

// Mock the rateLimiter's createRedisClient so no real Redis connection is made
vi.mock('../middleware/rateLimiter', async (importOriginal) => {
  const original = await importOriginal<typeof import('../middleware/rateLimiter')>();
  return {
    ...original,
    createRedisClient: vi.fn(() => ({ /* mock redis client */ })),
  };
});

// ---------------------------------------------------------------------------
// App setup (import AFTER mocks are registered)
// ---------------------------------------------------------------------------
import buybackRoutes from '../routes/buyback';

const app = express();
app.use(express.json());
app.use('/api/buyback', buybackRoutes);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeActiveCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    tokenAddress: 'CTOKEN123',
    totalAmount: '10000',
    executedAmount: '0',
    currentStep: 0,
    totalSteps: 3,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    steps: [
      { id: 1, stepNumber: 0, amount: '2000', status: 'PENDING', executedAt: null, txHash: null },
      { id: 2, stepNumber: 1, amount: '3000', status: 'PENDING', executedAt: null, txHash: null },
      { id: 3, stepNumber: 2, amount: '5000', status: 'PENDING', executedAt: null, txHash: null },
    ],
    ...overrides,
  };
}

function makeUpdatedStep(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    stepNumber: 0,
    amount: '2000',
    status: 'COMPLETED',
    executedAt: new Date(),
    txHash: 'tx-abc',
    ...overrides,
  };
}

function makeUpdatedCampaign(overrides: Record<string, unknown> = {}) {
  return {
    ...makeActiveCampaign(),
    executedAmount: '2000',
    currentStep: 1,
    steps: [
      { id: 1, stepNumber: 0, amount: '2000', status: 'COMPLETED', executedAt: new Date(), txHash: 'tx-abc' },
      { id: 2, stepNumber: 1, amount: '3000', status: 'PENDING', executedAt: null, txHash: null },
      { id: 3, stepNumber: 2, amount: '5000', status: 'PENDING', executedAt: null, txHash: null },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Campaign Step Distributed Lock — Concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReleaseStepLock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── L1: Concurrent second request returns 202 PROCESSING ─────────────────

  it('L1: second concurrent request returns 202 with PROCESSING status while lock is held', async () => {
    mockFindUnique.mockResolvedValue(makeActiveCampaign());

    // First caller holds the lock
    mockAcquireStepLock.mockResolvedValue({
      acquired: false,
      holderRequestId: 'req-holder-abc',
    });

    const res = await request(app)
      .post('/api/buyback/campaigns/1/execute-step')
      .send({ txHash: 'tx-attempt' })
      .expect(202);

    expect(res.body.status).toBe('PROCESSING');
    expect(res.body.holderRequestId).toBe('req-holder-abc');

    // DB writes must NOT have been called
    expect(mockStepUpdate).not.toHaveBeenCalled();
    expect(mockCampaignUpdate).not.toHaveBeenCalled();
  });

  // ── L2: First request succeeds (200) when lock is acquired ───────────────

  it('L2: first request acquires the lock and executes the step successfully', async () => {
    mockFindUnique.mockResolvedValue(makeActiveCampaign());
    mockAcquireStepLock.mockResolvedValue({
      acquired: true,
      holderRequestId: 'req-owner-xyz',
    });
    mockStepUpdate.mockResolvedValue(makeUpdatedStep());
    mockCampaignUpdate.mockResolvedValue(makeUpdatedCampaign());

    const res = await request(app)
      .post('/api/buyback/campaigns/1/execute-step')
      .send({ txHash: 'tx-abc' })
      .expect(200);

    expect(res.body.campaign.currentStep).toBe(1);
    expect(res.body.executedStep.status).toBe('COMPLETED');

    // Lock must have been acquired and then released
    expect(mockAcquireStepLock).toHaveBeenCalledTimes(1);
    expect(mockReleaseStepLock).toHaveBeenCalledTimes(1);
  });

  // ── L3: Lock is released after successful execution ───────────────────────

  it('L3: lock is released in finally block after successful execution', async () => {
    const releaseOrder: string[] = [];

    mockFindUnique.mockResolvedValue(makeActiveCampaign());
    mockAcquireStepLock.mockResolvedValue({ acquired: true, holderRequestId: 'req-1' });
    mockStepUpdate.mockImplementation(async () => {
      releaseOrder.push('step-updated');
      return makeUpdatedStep();
    });
    mockCampaignUpdate.mockImplementation(async () => {
      releaseOrder.push('campaign-updated');
      return makeUpdatedCampaign();
    });
    mockReleaseStepLock.mockImplementation(async () => {
      releaseOrder.push('lock-released');
      return true;
    });

    await request(app)
      .post('/api/buyback/campaigns/1/execute-step')
      .send({ txHash: 'tx-abc' })
      .expect(200);

    expect(releaseOrder).toEqual(['step-updated', 'campaign-updated', 'lock-released']);
    expect(mockReleaseStepLock).toHaveBeenCalledWith(
      expect.anything(),
      1,          // campaignId
      0,          // stepNumber (currentStep)
      expect.any(String), // requestId (UUID generated per request)
    );
  });

  // ── L4: Lock is released even when execution fails ────────────────────────

  it('L4: lock is released in finally block even when DB update throws', async () => {
    mockFindUnique.mockResolvedValue(makeActiveCampaign());
    mockAcquireStepLock.mockResolvedValue({ acquired: true, holderRequestId: 'req-err' });
    mockStepUpdate.mockRejectedValue(new Error('DB connection lost'));

    const res = await request(app)
      .post('/api/buyback/campaigns/1/execute-step')
      .send({ txHash: 'tx-err' })
      .expect(500);

    expect(res.body.error).toBe('Failed to execute step');

    // Lock must still be released despite the error
    expect(mockReleaseStepLock).toHaveBeenCalledTimes(1);
  });

  // ── L5: Redis unavailable → fail open ────────────────────────────────────

  it('L5: when Redis is unavailable the step executes without a lock (fail open)', async () => {
    mockFindUnique.mockResolvedValue(makeActiveCampaign());

    // Simulate Redis error on lock acquisition
    mockAcquireStepLock.mockRejectedValue(new Error('Redis connection refused'));
    mockStepUpdate.mockResolvedValue(makeUpdatedStep());
    mockCampaignUpdate.mockResolvedValue(makeUpdatedCampaign());

    const res = await request(app)
      .post('/api/buyback/campaigns/1/execute-step')
      .send({ txHash: 'tx-failopen' })
      .expect(200);

    expect(res.body.campaign.currentStep).toBe(1);
    // No lock to release (lockAcquired = false)
    expect(mockReleaseStepLock).not.toHaveBeenCalled();
  });

  // ── L6: Different campaigns do not share locks ────────────────────────────

  it('L6: concurrent executions on different campaigns are independent', async () => {
    const campaign1 = makeActiveCampaign({ id: 1 });
    const campaign2 = makeActiveCampaign({ id: 2 });

    // Campaign 1 step is locked; campaign 2 step is free
    mockFindUnique
      .mockResolvedValueOnce(campaign1)  // first call (campaign 1)
      .mockResolvedValueOnce(campaign2); // second call (campaign 2)

    mockAcquireStepLock
      .mockResolvedValueOnce({ acquired: false, holderRequestId: 'holder-1' }) // campaign 1 — locked
      .mockResolvedValueOnce({ acquired: true, holderRequestId: 'req-2' });    // campaign 2 — free

    mockStepUpdate.mockResolvedValue(makeUpdatedStep());
    mockCampaignUpdate.mockResolvedValue(makeUpdatedCampaign({ id: 2 }));

    const [res1, res2] = await Promise.all([
      request(app).post('/api/buyback/campaigns/1/execute-step').send({ txHash: 'tx-1' }),
      request(app).post('/api/buyback/campaigns/2/execute-step').send({ txHash: 'tx-2' }),
    ]);

    expect(res1.status).toBe(202);
    expect(res1.body.status).toBe('PROCESSING');

    expect(res2.status).toBe(200);
    expect(res2.body.campaign).toBeDefined();

    // Only campaign 2 should have triggered a DB write
    expect(mockStepUpdate).toHaveBeenCalledTimes(1);
  });

  // ── Edge: campaign not found before lock acquisition ─────────────────────

  it('returns 404 and never acquires the lock when campaign does not exist', async () => {
    mockFindUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/buyback/campaigns/999/execute-step')
      .send({ txHash: 'tx-ghost' })
      .expect(404);

    expect(res.body.error).toBe('Campaign not found');
    expect(mockAcquireStepLock).not.toHaveBeenCalled();
    expect(mockReleaseStepLock).not.toHaveBeenCalled();
  });
});
