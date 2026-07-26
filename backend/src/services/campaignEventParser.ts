import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export interface CampaignEvent {
  campaignId: number;
  tokenId: string;
  creator: string;
  type: "BUYBACK" | "AIRDROP" | "LIQUIDITY";
  targetAmount: bigint;
  startTime: Date;
  endTime?: Date;
  metadata?: string;
  txHash: string;
}

export interface CampaignExecutionEvent {
  campaignId: number;
  executor: string;
  amount: bigint;
  recipient?: string;
  txHash: string;
  executedAt: Date;
}

export interface CampaignStatusEvent {
  campaignId: number;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  txHash: string;
}

export interface CampaignParseError {
  field: string;
  message: string;
}

export type CampaignParseResult<T> =
  | { success: true; data: T }
  | { success: false; errors: CampaignParseError[] };

export class CampaignEventParser {
  static readonly CAMPAIGN_CREATED = "campaign_created";
  static readonly CAMPAIGN_EXECUTED = "campaign_executed";
  static readonly CAMPAIGN_STATUS_CHANGED = "campaign_status_changed";

  static safeParseCampaignCreated(
    raw: unknown,
  ): CampaignParseResult<CampaignEvent> {
    if (!raw || typeof raw !== "object") {
      return {
        success: false,
        errors: [{ field: "root", message: "Expected an object payload" }],
      };
    }

    const errors: CampaignParseError[] = [];
    const r = raw as Record<string, unknown>;

    if (!("campaignId" in r) || typeof r.campaignId !== "number") {
      errors.push({ field: "campaignId", message: "must be a number" });
    }
    if (!("tokenId" in r) || typeof r.tokenId !== "string") {
      errors.push({ field: "tokenId", message: "must be a non-empty string" });
    }
    if (!("creator" in r) || typeof r.creator !== "string") {
      errors.push({ field: "creator", message: "must be a non-empty string" });
    }

    const validTypes = ["BUYBACK", "AIRDROP", "LIQUIDITY"] as const;
    if (
      !("type" in r) ||
      typeof r.type !== "string" ||
      !(validTypes as readonly string[]).includes(r.type)
    ) {
      errors.push({
        field: "type",
        message: `must be one of: ${validTypes.join(", ")}`,
      });
    }

    if (
      !("targetAmount" in r) ||
      (typeof r.targetAmount !== "bigint" && typeof r.targetAmount !== "string" && typeof r.targetAmount !== "number")
    ) {
      errors.push({ field: "targetAmount", message: "must be a numeric value" });
    } else if (typeof r.targetAmount !== "bigint") {
      const asStr =
        typeof r.targetAmount === "number"
          ? Math.trunc(r.targetAmount).toString()
          : (r.targetAmount as string).trim();
      if (!/^-?\d+$/.test(asStr)) {
        errors.push({ field: "targetAmount", message: "must be a numeric value" });
      }
    }

    if (!("startTime" in r) || !(r.startTime instanceof Date)) {
      errors.push({ field: "startTime", message: "must be a Date" });
    }

    if ("endTime" in r && r.endTime !== undefined && !(r.endTime instanceof Date)) {
      errors.push({ field: "endTime", message: "must be a Date" });
    }

    if ("metadata" in r && typeof r.metadata !== "undefined" && typeof r.metadata !== "string") {
      errors.push({ field: "metadata", message: "must be a string" });
    }

    if (!("txHash" in r) || typeof r.txHash !== "string") {
      errors.push({ field: "txHash", message: "must be a non-empty string" });
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    const targetAmount =
      typeof r.targetAmount === "bigint"
        ? r.targetAmount
        : BigInt(r.targetAmount as string | number);

    return {
      success: true,
      data: {
        campaignId: r.campaignId as number,
        tokenId: r.tokenId as string,
        creator: r.creator as string,
        type: r.type as "BUYBACK" | "AIRDROP" | "LIQUIDITY",
        targetAmount,
        startTime: r.startTime as Date,
        endTime: r.endTime !== undefined ? (r.endTime as Date) : undefined,
        metadata: r.metadata as string | undefined,
        txHash: r.txHash as string,
      },
    };
  }

  static safeParseCampaignExecution(
    raw: unknown,
  ): CampaignParseResult<CampaignExecutionEvent> {
    if (!raw || typeof raw !== "object") {
      return {
        success: false,
        errors: [{ field: "root", message: "Expected an object payload" }],
      };
    }

    const errors: CampaignParseError[] = [];
    const r = raw as Record<string, unknown>;

    if (!("campaignId" in r) || typeof r.campaignId !== "number") {
      errors.push({ field: "campaignId", message: "must be a number" });
    }
    if (!("executor" in r) || typeof r.executor !== "string") {
      errors.push({ field: "executor", message: "must be a non-empty string" });
    }
    if (
      !("amount" in r) ||
      (typeof r.amount !== "bigint" && typeof r.amount !== "string" && typeof r.amount !== "number")
    ) {
      errors.push({ field: "amount", message: "must be a numeric value" });
    }
    if ("recipient" in r && typeof r.recipient !== "undefined" && typeof r.recipient !== "string") {
      errors.push({ field: "recipient", message: "must be a string" });
    }
    if (!("txHash" in r) || typeof r.txHash !== "string") {
      errors.push({ field: "txHash", message: "must be a non-empty string" });
    }
    if (!("executedAt" in r) || !(r.executedAt instanceof Date)) {
      errors.push({ field: "executedAt", message: "must be a Date" });
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    const amount =
      typeof r.amount === "bigint"
        ? r.amount
        : BigInt(r.amount as string | number);

    return {
      success: true,
      data: {
        campaignId: r.campaignId as number,
        executor: r.executor as string,
        amount,
        recipient: r.recipient as string | undefined,
        txHash: r.txHash as string,
        executedAt: r.executedAt as Date,
      },
    };
  }

  static safeParseCampaignStatusChange(
    raw: unknown,
  ): CampaignParseResult<CampaignStatusEvent> {
    if (!raw || typeof raw !== "object") {
      return {
        success: false,
        errors: [{ field: "root", message: "Expected an object payload" }],
      };
    }

    const errors: CampaignParseError[] = [];
    const r = raw as Record<string, unknown>;

    if (!("campaignId" in r) || typeof r.campaignId !== "number") {
      errors.push({ field: "campaignId", message: "must be a number" });
    }

    const validStatuses = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;
    if (
      !("status" in r) ||
      typeof r.status !== "string" ||
      !(validStatuses as readonly string[]).includes(r.status)
    ) {
      errors.push({
        field: "status",
        message: `must be one of: ${validStatuses.join(", ")}`,
      });
    }

    if (!("txHash" in r) || typeof r.txHash !== "string") {
      errors.push({ field: "txHash", message: "must be a non-empty string" });
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    return {
      success: true,
      data: {
        campaignId: r.campaignId as number,
        status: r.status as "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED",
        txHash: r.txHash as string,
      },
    };
  }

  static safeParseCampaignEvent(raw: unknown): CampaignParseResult<
    CampaignEvent | CampaignExecutionEvent | CampaignStatusEvent
  > {
    if (!raw || typeof raw !== "object") {
      return {
        success: false,
        errors: [{ field: "root", message: "Expected an object payload" }],
      };
    }

    const r = raw as Record<string, unknown>;
    const kind = typeof r.kind === "string" ? r.kind : undefined;

    switch (kind) {
      case this.CAMPAIGN_CREATED:
        return this.safeParseCampaignCreated(r) as CampaignParseResult<
          CampaignEvent | CampaignExecutionEvent | CampaignStatusEvent
        >;
      case this.CAMPAIGN_EXECUTED:
        return this.safeParseCampaignExecution(r) as CampaignParseResult<
          CampaignEvent | CampaignExecutionEvent | CampaignStatusEvent
        >;
      case this.CAMPAIGN_STATUS_CHANGED:
        return this.safeParseCampaignStatusChange(r) as CampaignParseResult<
          CampaignEvent | CampaignExecutionEvent | CampaignStatusEvent
        >;
      default: {
        const unknownKind = kind ?? "<missing>";
        return {
          success: false,
          errors: [
            {
              field: "kind",
              message: `Unknown event variant "${unknownKind}"`,
            },
          ],
        };
      }
    }
  }
}

export const campaignEventParser = new CampaignEventParser();
