/**
 * Smoke test for #1333: distributed trace-context propagation.
 *
 * Verifies the W3C `traceparent` header an inbound request arrives with is
 * captured by `requestLoggingMiddleware`, attached to the async context, and
 * re-emitted on outbound calls made via `outboundHttpClient` — even with no
 * OpenTelemetry SDK registered (the state Vitest runs in), exercising the
 * fallback-to-raw-incoming-header path described in `outboundHttpClient.ts`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestLoggingMiddleware } from '../middleware/request-logging.middleware';
import { parseTraceParent } from '../middleware/correlation-logging';
import { getTraceContext } from '../lib/async-context';
import { buildPropagationHeaders, outboundFetch } from '../lib/outboundHttpClient';

const SAMPLE_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function buildApp(handler: express.RequestHandler) {
  const app = express();
  app.use(requestLoggingMiddleware);
  app.get('/test', handler);
  return app;
}

describe('parseTraceParent', () => {
  it('parses a well-formed traceparent header', () => {
    const parsed = parseTraceParent(SAMPLE_TRACEPARENT);
    expect(parsed).toEqual({
      version: '00',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentId: '00f067aa0ba902b7',
      traceFlags: '01',
      raw: SAMPLE_TRACEPARENT,
    });
  });

  it('returns undefined for a malformed header', () => {
    expect(parseTraceParent('not-a-traceparent')).toBeUndefined();
  });

  it('returns undefined for an all-zero trace-id (explicitly invalid per spec)', () => {
    expect(
      parseTraceParent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')
    ).toBeUndefined();
  });

  it('returns undefined when the header is absent', () => {
    expect(parseTraceParent(undefined)).toBeUndefined();
  });
});

describe('distributed trace propagation through the request pipeline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches the inbound traceparent to the async context', async () => {
    let captured: ReturnType<typeof getTraceContext>;

    const app = buildApp((_req, res) => {
      captured = getTraceContext();
      res.json({ ok: true });
    });

    await request(app)
      .get('/test')
      .set('traceparent', SAMPLE_TRACEPARENT)
      .expect(200);

    expect(captured).toBeDefined();
    expect(captured?.raw).toBe(SAMPLE_TRACEPARENT);
    expect(captured?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('leaves the trace context undefined when no traceparent is sent', async () => {
    let captured: ReturnType<typeof getTraceContext>;

    const app = buildApp((_req, res) => {
      captured = getTraceContext();
      res.json({ ok: true });
    });

    await request(app).get('/test').expect(200);

    expect(captured).toBeUndefined();
  });

  it('re-emits the inbound traceparent on outbound calls made during the request', async () => {
    let outboundHeaders: Record<string, string> | undefined;

    const app = buildApp((_req, res) => {
      outboundHeaders = buildPropagationHeaders();
      res.json({ ok: true });
    });

    await request(app)
      .get('/test')
      .set('traceparent', SAMPLE_TRACEPARENT)
      .expect(200);

    expect(outboundHeaders?.traceparent).toBe(SAMPLE_TRACEPARENT);
  });

  it('outboundFetch sets the traceparent header on the actual outgoing request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    const app = buildApp((_req, res) => {
      outboundFetch('https://downstream.internal/api/resource').then(() =>
        res.json({ ok: true })
      );
    });

    await request(app)
      .get('/test')
      .set('traceparent', SAMPLE_TRACEPARENT)
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get('traceparent')).toBe(SAMPLE_TRACEPARENT);
  });
});
