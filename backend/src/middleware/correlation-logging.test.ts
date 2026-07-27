import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { CorrelationLogger } from './correlation-logging';
import { runWithContext, getCorrelationId } from '../lib/async-context';
import { JobQueue } from '../services/jobQueue';

describe('CorrelationLogger', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      headers: {},
      method: 'GET',
      path: '/api/test',
    };
    mockRes = {
      statusCode: 200,
      setHeader: vi.fn(),
      send: vi.fn(),
    };
    mockNext = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('should generate correlation ID', () => {
    const id = CorrelationLogger.generateCorrelationId();
    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('should extract existing correlation ID from headers', () => {
    const existingId = 'existing-id-123';
    mockReq.headers = { 'x-correlation-id': existingId };

    const id = CorrelationLogger.extractCorrelationId(mockReq as Request);
    expect(id).toBe(existingId);
  });

  it('should generate new correlation ID if not in headers', () => {
    const id = CorrelationLogger.extractCorrelationId(mockReq as Request);
    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
  });

  it('should log structured messages', () => {
    const correlationId = 'test-id-123';
    const message = 'Test message';
    const metadata = { userId: 'user123' };

    CorrelationLogger.log(correlationId, 'info', message, metadata);

    expect(console.log).toHaveBeenCalled();
    const logCall = (console.log as any).mock.calls[0][0];
    const parsed = JSON.parse(logCall);

    expect(parsed.correlationId).toBe(correlationId);
    expect(parsed.message).toBe(message);
    expect(parsed.level).toBe('info');
    expect(parsed.metadata).toEqual(metadata);
  });

  it('should attach correlation ID to request', () => {
    const middleware = CorrelationLogger.middleware();
    middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockReq.correlationId).toBeDefined();
    expect(mockNext).toHaveBeenCalled();
  });

  it('should set correlation ID header in response', () => {
    const middleware = CorrelationLogger.middleware();
    middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockRes.setHeader).toHaveBeenCalledWith(
      'x-correlation-id',
      expect.any(String)
    );
  });

  it('should log request with duration', (done) => {
    const middleware = CorrelationLogger.middleware();
    const originalSend = mockRes.send;

    middleware(mockReq as Request, mockRes as Response, mockNext);

    setTimeout(() => {
      (mockRes.send as any)('response data');

      const logCall = (console.log as any).mock.calls[0][0];
      const parsed = JSON.parse(logCall);

      expect(parsed.duration).toBeGreaterThanOrEqual(0);
      expect(parsed.method).toBe('GET');
      expect(parsed.path).toBe('/api/test');
      done();
    }, 10);
  });

  it('should set error level for 4xx/5xx responses', () => {
    mockRes.statusCode = 500;
    const middleware = CorrelationLogger.middleware();

    middleware(mockReq as Request, mockRes as Response, mockNext);
    (mockRes.send as any)('error');

    const logCall = (console.log as any).mock.calls[0][0];
    const parsed = JSON.parse(logCall);

    expect(parsed.level).toBe('error');
    expect(parsed.statusCode).toBe(500);
  });

  it('should preserve correlation ID across requests', () => {
    const correlationId = 'preserved-id-123';
    mockReq.headers = { 'x-correlation-id': correlationId };

    const middleware = CorrelationLogger.middleware();
    middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockReq.correlationId).toBe(correlationId);
  });
});

// ---------------------------------------------------------------------------
// Async job queue — correlation ID propagation
// ---------------------------------------------------------------------------

describe('JobQueue — correlation ID propagation', () => {
  /** Wait for all pending microtasks + a short real delay. */
  function flush(ms = 30): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  let q: JobQueue;

  beforeEach(() => {
    q = new JobQueue(2);
    q.start();
  });

  afterEach(() => {
    q.stop();
  });

  it('attaches the current correlation ID to the enqueued job', () => {
    q.register('cid.attach', async () => {});

    let job: ReturnType<typeof q.enqueue>;
    runWithContext('req-attach-id', () => {
      job = q.enqueue('cid.attach', {});
    });

    expect(job!.correlationId).toBe('req-attach-id');
  });

  it('stores undefined correlationId when enqueued outside a request context', () => {
    q.register('cid.none', async () => {});
    const job = q.enqueue('cid.none', {});
    expect(job.correlationId).toBeUndefined();
  });

  it('restores the correlation ID inside the job worker', async () => {
    let capturedId: string | undefined;

    q.register('cid.worker', async () => {
      capturedId = getCorrelationId();
    });

    runWithContext('req-worker-id', () => {
      q.enqueue('cid.worker', {});
    });

    await flush();

    expect(capturedId).toBe('req-worker-id');
  });

  it('worker runs without a correlation context when none was set at enqueue time', async () => {
    let capturedId: string | undefined = 'sentinel';

    q.register('cid.nocontext', async () => {
      capturedId = getCorrelationId();
    });

    q.enqueue('cid.nocontext', {});
    await flush();

    expect(capturedId).toBeUndefined();
  });

  it('logs emitted inside a job worker include the originating correlationId', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    q.register('cid.log', async () => {
      CorrelationLogger.log(getCorrelationId()!, 'info', 'job ran');
    });

    runWithContext('req-log-id', () => {
      q.enqueue('cid.log', {});
    });

    await flush();

    const calls = logSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    const jobLog = calls.find((e) => e.message === 'job ran');

    expect(jobLog).toBeDefined();
    expect(jobLog!.correlationId).toBe('req-log-id');

    logSpy.mockRestore();
  });

  it('isolates correlation IDs across concurrent jobs from different requests', async () => {
    const captured: Record<string, string | undefined> = {};

    q.register('cid.iso', async (job: any) => {
      captured[job.payload.label] = getCorrelationId();
    });

    runWithContext('req-A', () => {
      q.enqueue('cid.iso', { label: 'A' });
    });

    runWithContext('req-B', () => {
      q.enqueue('cid.iso', { label: 'B' });
    });

    await flush(50);

    expect(captured['A']).toBe('req-A');
    expect(captured['B']).toBe('req-B');
  });
});
