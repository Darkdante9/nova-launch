import { NextRequest, NextResponse } from "next/server";
import { Database } from "@/config/database";
import { CursorPagination } from "@/lib/pagination";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    const cursor = searchParams.get("cursor") || undefined;
    const rawLimit = searchParams.get("limit");
    const rawOffset = searchParams.get("offset");

    const limit = CursorPagination.validateLimit(
      rawLimit !== null ? Number(rawLimit) : undefined
    );

    let offset: number | undefined;
    if (!cursor && rawOffset !== null) {
      const parsedOffset = Number(rawOffset);
      if (Number.isNaN(parsedOffset) || parsedOffset < 0) {
        return NextResponse.json(
          { error: "Invalid offset parameter" },
          { status: 400 }
        );
      }
      offset = parsedOffset;
    }

    const tokens = await Database.getAllTokens();

    const result = CursorPagination.paginateByCreatedAt(tokens, {
      cursor,
      limit,
      offset,
    });

    return NextResponse.json({
      tokens: result.items,
      nextCursor: result.nextCursor ?? null,
      hasMore: result.hasMore,
      total: result.total,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid cursor format") {
      return NextResponse.json(
        { error: "Invalid cursor parameter" },
        { status: 400 }
      );
    }

    console.error("Tokens list error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
