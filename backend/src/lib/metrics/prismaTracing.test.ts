import { describe, it, expect, vi } from 'vitest';
import { registerPrismaTracing } from './prismaTracing';

describe('registerPrismaTracing', () => {
  function fakeClient() {
    let middleware: (params: any, next: any) => Promise<unknown>;
    return {
      $use: vi.fn((mw: typeof middleware) => {
        middleware = mw;
      }),
      run(params: any, next: any) {
        return middleware(params, next);
      },
    };
  }

  it('registers exactly one $use middleware', () => {
    const client = fakeClient();
    registerPrismaTracing(client as any);
    expect(client.$use).toHaveBeenCalledTimes(1);
  });

  it('passes through the query result on success', async () => {
    const client = fakeClient();
    registerPrismaTracing(client as any);

    const next = vi.fn().mockResolvedValue({ id: 1 });
    const result = await client.run({ model: 'User', action: 'findUnique', args: {} }, next);

    expect(result).toEqual({ id: 1 });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from the query without swallowing them', async () => {
    const client = fakeClient();
    registerPrismaTracing(client as any);

    const boom = new Error('connection lost');
    const next = vi.fn().mockRejectedValue(boom);

    await expect(
      client.run({ model: 'User', action: 'findUnique', args: {} }, next)
    ).rejects.toThrow('connection lost');
  });

  it('does not throw when the query has no model (e.g. $transaction)', async () => {
    const client = fakeClient();
    registerPrismaTracing(client as any);

    const next = vi.fn().mockResolvedValue([]);
    const result = await client.run({ action: 'queryRaw', args: { sql: 'SELECT 1' } }, next);

    expect(result).toEqual([]);
  });
});
