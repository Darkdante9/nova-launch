import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runWithContext, TraceContext } from '../lib/async-context';

/**
 * Matches a well-formed W3C `traceparent` header value:
 *   version(2 hex) - trace-id(32 hex) - parent-id(16 hex) - trace-flags(2 hex)
 *
 * See https://www.w3.org/TR/trace-context/#traceparent-header
 */
const TRACEPARENT_PATTERN =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/**
 * Parse an incoming `traceparent` header into its component parts.
 * Returns `undefined` if the header is missing or malformed — callers should
 * treat a malformed header the same as an absent one (start a fresh trace)
 * rather than propagating garbage context downstream.
 */
export function parseTraceParent(
  value: string | string[] | undefined
): TraceContext | undefined {
  if (typeof value !== 'string') return undefined;

  const match = TRACEPARENT_PATTERN.exec(value.trim());
  if (!match) return undefined;

  const [, version, traceId, parentId, traceFlags] = match;

  // The all-zero trace-id / parent-id values are explicitly invalid per spec.
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return undefined;

  return {
    version,
    traceId,
    parentId,
    traceFlags,
    raw: value.trim(),
  };
}

interface StructuredLog {
  timestamp: string;
  correlationId: string;
  level: 'info' | 'error' | 'warn' | 'debug';
  message: string;
  method?: string;
  path?: string;
  statusCode?: number;
  duration?: number;
  userId?: string;
  metadata?: Record<string, any>;
}

export class CorrelationLogger {
  private static readonly CORRELATION_ID_HEADER = 'x-correlation-id';
  private static readonly TRACEPARENT_HEADER = 'traceparent';

  static generateCorrelationId(): string {
    return uuidv4();
  }

  static extractCorrelationId(req: Request): string {
    const existing = req.headers[this.CORRELATION_ID_HEADER];
    if (typeof existing === 'string') return existing;
    return this.generateCorrelationId();
  }

  /**
   * Extract and parse the incoming W3C `traceparent` header, if present.
   * Returns `undefined` when the header is absent or malformed so that the
   * async context simply omits trace linkage rather than storing bad data.
   */
  static extractTraceContext(req: Request): TraceContext | undefined {
    return parseTraceParent(req.headers[this.TRACEPARENT_HEADER]);
  }

  static log(
    correlationId: string,
    level: 'info' | 'error' | 'warn' | 'debug',
    message: string,
    metadata?: Record<string, any>
  ): void {
    const log: StructuredLog = {
      timestamp: new Date().toISOString(),
      correlationId,
      level,
      message,
      metadata,
    };

    console.log(JSON.stringify(log));
  }

  static middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const correlationId = this.extractCorrelationId(req);
      const traceContext = this.extractTraceContext(req);
      const startTime = Date.now();

      req.correlationId = correlationId;
      res.setHeader(this.CORRELATION_ID_HEADER, correlationId);

      runWithContext(
        correlationId,
        () => {
          const originalSend = res.send;
          res.send = function (data: any) {
            const duration = Date.now() - startTime;
            const log: StructuredLog = {
              timestamp: new Date().toISOString(),
              correlationId,
              level: res.statusCode >= 400 ? 'error' : 'info',
              message: `${req.method} ${req.path}`,
              method: req.method,
              path: req.path,
              statusCode: res.statusCode,
              duration,
              userId: (req as any).userId,
            };

            console.log(JSON.stringify(log));
            return originalSend.call(this, data);
          };

          next();
        },
        undefined,
        traceContext
      );
    };
  }
}

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}
