/**
 * Per-query OpenTelemetry tracing for Prisma (#1333).
 *
 * Creates one span per Prisma Client call (`prisma.<model>.<action>`) so
 * database calls show up as child spans of the request/job span that
 * triggered them, joining the rest of the distributed trace.
 *
 * Raw-query SQL is attached to the span as `db.statement` when it is safe to
 * do so: `$queryRaw`/`$executeRaw` (tagged template) values are already
 * parameterized by Prisma, but `$queryRawUnsafe`/`$executeRawUnsafe` accept
 * caller-built strings that may contain interpolated literals, so those are
 * redacted rather than logged verbatim.
 *
 * Call `registerPrismaTracing(prismaClient)` once at startup, alongside
 * `registerPoolMetrics`.
 */

import type { PrismaClient } from "@prisma/client";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("nova-launch-backend-prisma");

const UNSAFE_RAW_ACTIONS = new Set(["queryRawUnsafe", "executeRawUnsafe"]);
const RAW_ACTIONS = new Set([
  "queryRaw",
  "executeRaw",
  ...UNSAFE_RAW_ACTIONS,
]);

interface PrismaMiddlewareParams {
  model?: string;
  action: string;
  args: unknown;
}

function sanitizedStatement(params: PrismaMiddlewareParams): string | undefined {
  if (!RAW_ACTIONS.has(params.action)) return undefined;

  if (UNSAFE_RAW_ACTIONS.has(params.action)) {
    return "[redacted: *Unsafe raw query, may contain literals]";
  }

  // `$queryRaw`/`$executeRaw` tagged-template calls receive a `Prisma.Sql`
  // object whose `.sql` is already parameterized (e.g. `$1`, `$2`, ...).
  const sql = (params.args as { sql?: string } | undefined)?.sql;
  return typeof sql === "string" ? sql : undefined;
}

/**
 * Attach per-query tracing to the given Prisma client.
 * Must be called once before the first query.
 */
export function registerPrismaTracing(client: PrismaClient): void {
  // @ts-expect-error – $use is available on PrismaClient at runtime
  client.$use(async (params: PrismaMiddlewareParams, next: (p: unknown) => Promise<unknown>) => {
    const spanName = params.model
      ? `prisma.${params.model}.${params.action}`
      : `prisma.${params.action}`;

    return tracer.startActiveSpan(spanName, async (span) => {
      span.setAttribute("db.system", "postgresql");
      span.setAttribute("db.operation", params.action);
      if (params.model) span.setAttribute("db.prisma.model", params.model);

      const statement = sanitizedStatement(params);
      if (statement) span.setAttribute("db.statement", statement);

      try {
        const result = await next(params);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    });
  });
}
