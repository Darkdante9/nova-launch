import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock auth middleware to bypass JWT for tests
vi.mock('../../middleware/auth', () => ({
  authenticateAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Import router after mocking
const { default: governanceRouter } = await import('../governance');

const app = express();
app.use(express.json());
app.use('/', governanceRouter);

describe('GET /api/admin/governance/timelock', () => {
  it('returns current timelock config', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.minDelay).toBe('number');
    expect(typeof res.body.data.maxDelay).toBe('number');
  });
});

describe('PUT /api/admin/governance/timelock', () => {
  it('updates timelock config with valid body', async () => {
    const res = await request(app)
      .put('/')
      .send({ minDelay: 7200, maxDelay: 172800 });
    expect(res.status).toBe(200);
    expect(res.body.data.minDelay).toBe(7200);
    expect(res.body.data.maxDelay).toBe(172800);
  });

  it('rejects non-number values', async () => {
    const res = await request(app)
      .put('/')
      .send({ minDelay: 'bad', maxDelay: 86400 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects maxDelay less than minDelay', async () => {
    const res = await request(app)
      .put('/')
      .send({ minDelay: 86400, maxDelay: 3600 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects negative minDelay', async () => {
    const res = await request(app)
      .put('/')
      .send({ minDelay: -1, maxDelay: 3600 });
    expect(res.status).toBe(400);
  });
});
