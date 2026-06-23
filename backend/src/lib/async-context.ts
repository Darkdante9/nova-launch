import { AsyncLocalStorage } from 'async_hooks';

interface RequestContext {
  correlationId: string;
  transactionId?: string;
  tenantId?: string;
  bypassTenant?: boolean;
}

export const asyncContext = new AsyncLocalStorage<RequestContext>();

export function getCorrelationId(): string | undefined {
  return asyncContext.getStore()?.correlationId;
}

export function getTransactionId(): string | undefined {
  return asyncContext.getStore()?.transactionId;
}

export function getTenantId(): string | undefined {
  return asyncContext.getStore()?.tenantId;
}

export function isBypassingTenant(): boolean {
  return asyncContext.getStore()?.bypassTenant === true;
}

export function runWithContext<T>(
  correlationId: string,
  fn: () => T,
  transactionId?: string
): T {
  return asyncContext.run({ correlationId, transactionId }, fn);
}

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  const store = asyncContext.getStore();
  return asyncContext.run(
    {
      correlationId: store?.correlationId ?? '',
      transactionId: store?.transactionId,
      tenantId,
    },
    fn
  );
}

export function runBypassing<T>(fn: () => T): T {
  const store = asyncContext.getStore();
  return asyncContext.run(
    {
      correlationId: store?.correlationId ?? '',
      transactionId: store?.transactionId,
      tenantId: store?.tenantId,
      bypassTenant: true,
    },
    fn
  );
}
