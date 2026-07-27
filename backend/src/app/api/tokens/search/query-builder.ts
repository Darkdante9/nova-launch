import { Prisma } from "@prisma/client";
import type { ValidatedSearchTokensQuery } from "./schema";
import { soundex } from "./phonetic";

export function buildTokenSearchQuery(params: ValidatedSearchTokensQuery) {
  const where: Prisma.TokenWhereInput = {};

  // Full-text search by name or symbol
  if (params.q) {
    where.OR = [
      { name: { contains: params.q, mode: "insensitive" } },
      { symbol: { contains: params.q, mode: "insensitive" } },
    ];
  }

  // Filter by creator address
  if (params.creator) {
    where.creator = { equals: params.creator, mode: "insensitive" };
  }

  // Filter by creation date range
  if (params.startDate || params.endDate) {
    where.createdAt = {};
    if (params.startDate) {
      where.createdAt.gte = new Date(params.startDate);
    }
    if (params.endDate) {
      where.createdAt.lte = new Date(params.endDate);
    }
  }

  // Filter by supply range
  if (params.minSupply || params.maxSupply) {
    where.totalSupply = {};
    if (params.minSupply) {
      where.totalSupply.gte = BigInt(params.minSupply);
    }
    if (params.maxSupply) {
      where.totalSupply.lte = BigInt(params.maxSupply);
    }
  }

  // Filter by burn status
  if (params.hasBurns !== undefined) {
    if (params.hasBurns === "true") {
      where.burnCount = { gt: 0 };
    } else {
      where.burnCount = { equals: 0 };
    }
  }

  // Build orderBy
  const orderBy: Prisma.TokenOrderByWithRelationInput = {};

  switch (params.sortBy) {
    case "created":
      orderBy.createdAt = params.sortOrder;
      break;
    case "burned":
      orderBy.totalBurned = params.sortOrder;
      break;
    case "supply":
      orderBy.totalSupply = params.sortOrder;
      break;
    case "name":
      orderBy.name = params.sortOrder;
      break;
  }

  return { where, orderBy };
}

/**
 * Build a Prisma query for phonetic search — identical to buildTokenSearchQuery
 * but omits the `q` filter so the caller can fetch a broad result set and
 * then apply application-level phonetic post-filtering via `phoneticSearch`.
 */
export function buildPhoneticSearchQuery(params: ValidatedSearchTokensQuery) {
  const baseParams = { ...params, q: undefined };
  return buildTokenSearchQuery(baseParams);
}

/**
 * Filter and sort tokens by phonetic similarity to `query`.
 * Exact symbol/name matches are ranked first (score 2), phonetic matches
 * second (score 1).  Tokens with no match are excluded.
 */
export function phoneticSearch<
  T extends { symbol: string; name: string },
>(tokens: T[], query: string): T[] {
  const q = query.toUpperCase();
  const qCode = soundex(query);

  const scored = tokens
    .map((token) => {
      const symbolUp = token.symbol.toUpperCase();
      const nameUp = token.name.toUpperCase();
      let score = 0;
      if (symbolUp === q || nameUp === q) {
        score = 2;
      } else if (soundex(token.symbol) === qCode || soundex(token.name) === qCode) {
        score = 1;
      }
      return { token, score };
    })
    .filter((r) => r.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((r) => r.token);
}
