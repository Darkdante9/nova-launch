import { Buffer } from 'buffer';

export interface PaginationParams {
  cursor?: string;
  limit?: number;
  direction?: 'forward' | 'backward';
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
  prevCursor?: string;
  hasMore: boolean;
  total?: number;
}

/**
 * Composite keyset cursor position used for stable `createdAt`+`id` ordered
 * pagination (so two rows with an identical `createdAt` never collide/skip).
 */
export interface CreatedAtCursor {
  createdAt: string;
  id: string;
}

export interface CreatedAtPaginationParams {
  cursor?: string;
  limit?: number;
  offset?: number;
}

export class CursorPagination {
  private static readonly DEFAULT_LIMIT = 20;
  private static readonly MAX_LIMIT = 100;

  static encodeCursor(value: string | number): string;
  static encodeCursor(value: CreatedAtCursor): string;
  static encodeCursor(value: string | number | CreatedAtCursor): string {
    if (typeof value === 'object' && value !== null) {
      return Buffer.from(JSON.stringify(value)).toString('base64');
    }
    return Buffer.from(String(value)).toString('base64');
  }

  static decodeCursor(cursor: string): string {
    try {
      return Buffer.from(cursor, 'base64').toString('utf-8');
    } catch {
      throw new Error('Invalid cursor format');
    }
  }

  /**
   * Decodes a composite `createdAt`+`id` keyset cursor produced by
   * {@link encodeCursor} (object form). Throws on malformed input so callers
   * can surface a 400 to the client instead of silently mis-paginating.
   */
  static decodeCreatedAtCursor(cursor: string): CreatedAtCursor {
    const decoded = this.decodeCursor(cursor);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new Error('Invalid cursor format');
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as CreatedAtCursor).createdAt !== 'string' ||
      typeof (parsed as CreatedAtCursor).id !== 'string' ||
      Number.isNaN(Date.parse((parsed as CreatedAtCursor).createdAt))
    ) {
      throw new Error('Invalid cursor format');
    }

    return parsed as CreatedAtCursor;
  }

  static validateLimit(limit?: number): number {
    if (!limit) return this.DEFAULT_LIMIT;
    if (limit < 1) return this.DEFAULT_LIMIT;
    if (limit > this.MAX_LIMIT) return this.MAX_LIMIT;
    return limit;
  }

  static parsePaginationParams(params: PaginationParams) {
    const limit = this.validateLimit(params.limit);
    const direction = params.direction || 'forward';
    let decodedCursor: string | null = null;

    if (params.cursor) {
      try {
        decodedCursor = this.decodeCursor(params.cursor);
      } catch {
        throw new Error('Invalid cursor');
      }
    }

    return { limit, direction, cursor: decodedCursor };
  }

  static paginate<T extends { id: string | number }>(
    items: T[],
    params: PaginationParams
  ): PaginatedResult<T> {
    const { limit, direction, cursor } = this.parsePaginationParams(params);

    let startIndex = 0;
    if (cursor) {
      startIndex = items.findIndex(item => String(item.id) === cursor);
      if (startIndex === -1) {
        throw new Error('Cursor not found');
      }
      startIndex = direction === 'forward' ? startIndex + 1 : Math.max(0, startIndex - limit - 1);
    }

    const endIndex = startIndex + limit;
    const paginatedItems = items.slice(startIndex, endIndex);

    const nextCursor =
      endIndex < items.length
        ? this.encodeCursor(String(paginatedItems[paginatedItems.length - 1]?.id))
        : undefined;

    const prevCursor =
      startIndex > 0
        ? this.encodeCursor(String(paginatedItems[0]?.id))
        : undefined;

    return {
      items: paginatedItems,
      nextCursor,
      prevCursor,
      hasMore: endIndex < items.length,
      total: items.length,
    };
  }

  static async paginateAsync<T extends { id: string | number }>(
    fetchFn: (offset: number, limit: number) => Promise<T[]>,
    params: PaginationParams
  ): Promise<PaginatedResult<T>> {
    const { limit } = this.parsePaginationParams(params);

    let offset = 0;
    if (params.cursor) {
      offset = parseInt(this.decodeCursor(params.cursor), 10);
    }

    const items = await fetchFn(offset, limit + 1);
    const hasMore = items.length > limit;
    const paginatedItems = items.slice(0, limit);

    const nextCursor = hasMore
      ? this.encodeCursor(String(offset + limit))
      : undefined;

    const prevCursor = offset > 0
      ? this.encodeCursor(String(Math.max(0, offset - limit)))
      : undefined;

    return {
      items: paginatedItems,
      nextCursor,
      prevCursor,
      hasMore,
    };
  }

  /**
   * Keyset-paginates `items` by a stable `(createdAt desc, id asc)` order
   * using an opaque cursor that encodes the last-seen `(createdAt, id)`
   * pair. Unlike {@link paginate} (which locates a row by `id` alone and can
   * collide when several rows share the same `createdAt`), this compares the
   * full tuple so ties are resolved deterministically.
   *
   * Falls back to plain offset-based slicing of the same sorted list when no
   * `cursor` is supplied but an `offset` is (deprecated, kept for backward
   * compatibility with existing offset-based clients).
   */
  static paginateByCreatedAt<T extends { id: string | number; createdAt: Date | string }>(
    items: T[],
    params: CreatedAtPaginationParams
  ): PaginatedResult<T> {
    const limit = this.validateLimit(params.limit);

    const sorted = [...items].sort((a, b) => {
      const timeDiff =
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    });

    let startIndex = 0;

    if (params.cursor) {
      const { createdAt, id } = this.decodeCreatedAtCursor(params.cursor);
      const cursorTime = new Date(createdAt).getTime();
      // First index strictly "after" the cursor position in (createdAt desc, id asc) order.
      startIndex = sorted.findIndex((item) => {
        const itemTime = new Date(item.createdAt).getTime();
        if (itemTime !== cursorTime) return itemTime < cursorTime;
        return String(item.id) > id;
      });
      if (startIndex === -1) startIndex = sorted.length;
    } else if (params.offset !== undefined && params.offset > 0) {
      // Deprecated offset fallback.
      startIndex = params.offset;
    }

    const endIndex = startIndex + limit;
    const paginatedItems = sorted.slice(startIndex, endIndex);
    const hasMore = endIndex < sorted.length;

    const lastItem = paginatedItems[paginatedItems.length - 1];
    const nextCursor = hasMore && lastItem
      ? this.encodeCursor({
          createdAt: new Date(lastItem.createdAt).toISOString(),
          id: String(lastItem.id),
        })
      : undefined;

    return {
      items: paginatedItems,
      nextCursor,
      hasMore,
      total: sorted.length,
    };
  }
}
