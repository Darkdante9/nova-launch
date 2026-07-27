import { Router } from "express";
import { StreamStatus } from "@prisma/client";
import { streamProjectionService } from "../services/streamProjectionService";
import { successResponse, errorResponse } from "../utils/response";

const router = Router();

function parseListOpts(query: any) {
  const limit = Math.min(parseInt(query.limit as string) || 50, 200);
  const offset = parseInt(query.offset as string) || 0;
  const status = query.status as StreamStatus | undefined;
  if (status && !Object.values(StreamStatus).includes(status)) {
    return { error: `Invalid status. Must be one of: ${Object.values(StreamStatus).join(", ")}` };
  }
  return { limit, offset, status };
}

/** Max streams per page for keyset pagination (mirrors the on-chain contract limit). */
const MAX_KEYSET_LIMIT = 50;

function parseKeysetOpts(query: any) {
  const limit = Math.min(parseInt(query.limit as string) || MAX_KEYSET_LIMIT, MAX_KEYSET_LIMIT);
  const status = query.status as StreamStatus | undefined;
  if (status && !Object.values(StreamStatus).includes(status)) {
    return { error: `Invalid status. Must be one of: ${Object.values(StreamStatus).join(", ")}` };
  }

  let cursor: number | undefined;
  if (query.cursor !== undefined) {
    const parsed = parseInt(query.cursor as string);
    if (isNaN(parsed)) {
      return { error: "Invalid cursor. Must be the numeric streamId of the last item from the previous page." };
    }
    cursor = parsed;
  }

  return { limit, cursor, status };
}

/**
 * GET /api/streams/stats/:address?
 * Stream statistics for an address (creator or recipient), or global.
 */
router.get("/stats/:address?", async (req, res) => {
  try {
    const stats = await streamProjectionService.getStreamStats(req.params.address);
    res.json(successResponse(stats));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch stream stats" }));
  }
});

/**
 * GET /api/streams/creator/:address?status=CREATED&limit=50&offset=0
 * Streams created by address.
 */
router.get("/creator/:address", async (req, res) => {
  const opts = parseListOpts(req.query);
  if ("error" in opts) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: opts.error! }));
  try {
    const streams = await streamProjectionService.getStreamsByCreator(req.params.address, opts);
    res.json(successResponse(streams));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch creator streams" }));
  }
});

/**
 * GET /api/streams/creator/:address/paginated?status=CREATED&cursor=123&limit=50
 *
 * Keyset (cursor-based) pagination over streams created by `address`, ordered
 * by `streamId` ascending. Use this instead of the offset-based
 * `/creator/:address` endpoint for wallets with large stream collections:
 * offset pagination can skip or duplicate rows when streams are created
 * between page fetches, while this cursor always resumes strictly after the
 * last `streamId` returned. Mirrors the on-chain `list_streams_paginated`
 * keyset entry point. Pass `nextCursor` from the previous response as
 * `cursor` to fetch the next page; stop once `hasMore` is `false`.
 */
router.get("/creator/:address/paginated", async (req, res) => {
  const opts = parseKeysetOpts(req.query);
  if ("error" in opts) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: opts.error! }));
  try {
    const page = await streamProjectionService.getStreamsByCreatorKeyset(req.params.address, opts);
    res.json(successResponse(page));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch creator streams" }));
  }
});

/**
 * GET /api/streams/recipient/:address?status=CREATED&limit=50&offset=0
 * Streams where address is the recipient.
 */
router.get("/recipient/:address", async (req, res) => {
  const opts = parseListOpts(req.query);
  if ("error" in opts) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: opts.error! }));
  try {
    const streams = await streamProjectionService.getStreamsByRecipient(req.params.address, opts);
    res.json(successResponse(streams));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch recipient streams" }));
  }
});

/**
 * GET /api/streams/:id
 * Single stream by on-chain streamId.
 */
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json(errorResponse({ code: "INVALID_INPUT", message: "Invalid stream ID" }));
  try {
    const stream = await streamProjectionService.getStreamById(id);
    if (!stream) return res.status(404).json(errorResponse({ code: "NOT_FOUND", message: "Stream not found" }));
    res.json(successResponse(stream));
  } catch {
    res.status(500).json(errorResponse({ code: "INTERNAL_SERVER_ERROR", message: "Failed to fetch stream" }));
  }
});

export default router;
