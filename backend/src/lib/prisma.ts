import { PrismaClient } from "@prisma/client";
import { getTenantId, isBypassingTenant } from "./async-context";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres?schema=public";

const globalForPrisma = globalThis as unknown as {
  _baseprisma: PrismaClient | undefined;
};

const TENANT_SCOPED_MODELS = new Set([
  "WebhookSubscription",
  "BuybackCampaign",
  "DividendPool",
]);

const TENANT_FILTERED_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "updateMany",
  "deleteMany",
]);

const baseClient =
  globalForPrisma._basepisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
    datasources: {
      db: {
        url: connectionString,
      },
    },
  });

export const prisma = baseClient.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }: any) {
        if (
          model &&
          TENANT_SCOPED_MODELS.has(model) &&
          TENANT_FILTERED_OPS.has(operation)
        ) {
          const tenantId = getTenantId();
          const bypass = isBypassingTenant();
          if (!bypass && tenantId) {
            args = {
              ...args,
              where: { ...((args as any).where ?? {}), tenantId },
            };
          }
        }
        return query(args);
      },
    },
  },
});

export type ExtendedPrismaClient = typeof prisma;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma._basepisma = baseClient;
}

export default prisma;
