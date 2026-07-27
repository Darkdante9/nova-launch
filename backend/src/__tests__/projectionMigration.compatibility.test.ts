import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernanceEventMapper } from "../services/governanceEventMapper";
import { GovernanceEventParser } from "../services/governanceEventParser";
import { StreamEventParser } from "../services/streamEventParser";
import {
  compatibilityEnums,
  compatibilitySeedData,
  createCompatibilityHarness,
} from "./utils/seedIntegration";
import { legacyFixtures } from "./fixtures/legacySchemas";

function mockPrismaClientModule(prisma: any) {
  return {
    PrismaClient: vi.fn(() => prisma),
    Prisma: {},
    ProposalStatus: compatibilityEnums.ProposalStatus,
    ProposalType: compatibilityEnums.ProposalType,
    StreamStatus: compatibilityEnums.StreamStatus,
  };
}

async function loadCampaignModules(prisma: any) {
  vi.resetModules();
  vi.doMock("@prisma/client", () => mockPrismaClientModule(prisma));
  const campaignEventParserModule =
    await import("../services/campaignEventParser");
  const campaignProjectionModule =
    await import("../services/campaignProjectionService");

  return {
    CampaignEventParser: campaignEventParserModule.CampaignEventParser,
    CampaignProjectionService:
      campaignProjectionModule.CampaignProjectionService,
  };
}

afterEach(() => {
  vi.doUnmock("@prisma/client");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("projection migration compatibility", () => {
  it("keeps seeded governance and analytics data readable while ingesters continue writing", async () => {
    const { prisma, state } = createCompatibilityHarness("legacy-populated");
    const governanceParser = new GovernanceEventParser(prisma as any);
    const streamParser = new StreamEventParser(prisma as any);
    const { CampaignEventParser } = await loadCampaignModules(prisma);

    await governanceParser.parseVoteCastEvent(
      compatibilitySeedData.events.governance.vote
    );
    await streamParser.parseMetadataUpdatedEvent(
      compatibilitySeedData.events.stream.metadataUpdated
    );

    const campaignParser = new CampaignEventParser();
    await campaignParser.parseCampaignStatusChange(
      compatibilitySeedData.events.campaign.paused
    );

    const proposal = await prisma.proposal.findUnique({
      where: { proposalId: compatibilitySeedData.legacy.proposal.proposalId },
      include: { votes: true },
    });
    const stream = await prisma.stream.findUnique({
      where: { streamId: compatibilitySeedData.legacy.stream.streamId },
    });
    const campaign = await prisma.campaign.findUnique({
      where: { campaignId: compatibilitySeedData.legacy.campaign.campaignId },
    });

    expect(proposal?.title).toBe(compatibilitySeedData.legacy.proposal.title);
    expect(proposal?.votes).toHaveLength(2);
    expect(proposal?.votes[0].reason).toBeNull();
    expect(proposal?.votes[1].reason).toBe("Needs more runway data");

    expect(stream?.amount).toBe(compatibilitySeedData.legacy.stream.amount);
    expect(stream?.metadata).toBe("ipfs://legacy-stream-upgraded");
    expect(campaign?.currentAmount).toBe(
      compatibilitySeedData.legacy.campaign.currentAmount
    );
    expect(campaign?.status).toBe("PAUSED");

    expect(state.analytics).toHaveLength(1);
    expect(state.analytics[0].burnVolume).toBe(
      compatibilitySeedData.legacy.analytics.burnVolume
    );
  });

  it("replays historical governance, campaign, and stream events against the rolled-forward schema", async () => {
    const { prisma } = createCompatibilityHarness("empty");
    const governanceMapper = new GovernanceEventMapper();
    const governanceParser = new GovernanceEventParser(prisma as any);
    const streamParser = new StreamEventParser(prisma as any);
    const { CampaignEventParser, CampaignProjectionService } =
      await loadCampaignModules(prisma);

    for (const rawEvent of compatibilitySeedData.events.rawGovernance) {
      const mapped = governanceMapper.mapEvent(rawEvent as any);
      expect(mapped).not.toBeNull();
      await governanceParser.parseEvent(mapped!);
    }

    await streamParser.parseCreatedEvent(
      compatibilitySeedData.events.stream.created
    );
    await streamParser.parseClaimedEvent(
      compatibilitySeedData.events.stream.claimed
    );

    const campaignParser = new CampaignEventParser();
    await campaignParser.parseCampaignCreated(
      compatibilitySeedData.events.campaign.created
    );
    await campaignParser.parseCampaignExecution(
      compatibilitySeedData.events.campaign.executionFresh
    );
    await campaignParser.parseCampaignStatusChange(
      compatibilitySeedData.events.campaign.completed
    );

    const proposalAnalytics = await governanceParser.getProposalAnalytics(7302);
    const replayStream = await prisma.stream.findUnique({
      where: { streamId: 8202 },
    });
    const replayProposal = await prisma.proposal.findUnique({
      where: { proposalId: 7302 },
      include: { votes: true, executions: true },
    });

    const projectionService = new CampaignProjectionService();
    const replayCampaign = await projectionService.getCampaignById(9102);

    expect(proposalAnalytics.totalVotes).toBe(1);
    expect(proposalAnalytics.votesFor).toBe("42000");
    expect(proposalAnalytics.status).toBe(
      compatibilityEnums.ProposalStatus.EXECUTED
    );
    expect(replayProposal?.metadata).toBe(JSON.stringify({ replay: true }));
    expect(replayProposal?.executions).toHaveLength(1);

    expect(replayStream?.status).toBe(compatibilityEnums.StreamStatus.CLAIMED);
    expect(replayStream?.metadata).toBe("ipfs://stream-replay-metadata");
    expect(replayStream?.claimedAt).toEqual(
      compatibilitySeedData.events.stream.claimed.timestamp
    );

    expect(replayCampaign?.status).toBe("COMPLETED");
    expect(replayCampaign?.currentAmount).toBe(BigInt("15000"));
    expect(replayCampaign?.executionCount).toBe(1);
    expect(replayCampaign?.completedAt).not.toBeNull();
  });
});

describe("historical schema version regression – token projection migration", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // v1 Fixture: row with no metadataUri and no burnCount/totalBurned columns.
  // After migration (token.create through the harness) defaults must be filled.
  // ──────────────────────────────────────────────────────────────────────────
  it("v1 row: absent metadataUri and burnCount receive correct backfilled defaults", async () => {
    const { prisma } = createCompatibilityHarness("empty");

    const migrated = await prisma.token.create({
      data: {
        id: legacyFixtures.token.v1.id,
        address: legacyFixtures.token.v1.address,
        creator: legacyFixtures.token.v1.creator,
        name: legacyFixtures.token.v1.name,
        symbol: legacyFixtures.token.v1.symbol,
        decimals: legacyFixtures.token.v1.decimals,
        totalSupply: BigInt(legacyFixtures.token.v1.totalSupply),
        initialSupply: BigInt(legacyFixtures.token.v1.initialSupply),
        // intentionally omitting metadataUri and burnCount — v1 schema shape
      },
    });

    // Core fields must be preserved verbatim
    expect(migrated.address).toBe(legacyFixtures.token.v1.address);
    expect(migrated.name).toBe(legacyFixtures.token.v1.name);
    expect(migrated.symbol).toBe(legacyFixtures.token.v1.symbol);
    expect(migrated.totalSupply).toBe(BigInt(legacyFixtures.token.v1.totalSupply));
    expect(migrated.initialSupply).toBe(
      BigInt(legacyFixtures.token.v1.initialSupply)
    );

    // v1 → current defaults
    expect(migrated.metadataUri).toBeNull();
    expect(migrated.burnCount).toBe(0);
    expect(migrated.totalBurned).toBe(BigInt(0));
  });

  it("v1 row: migration is idempotent – running create twice yields identical state", async () => {
    const { prisma } = createCompatibilityHarness("empty");

    const firstRun = await prisma.token.create({
      data: {
        id: legacyFixtures.token.v1.id,
        address: legacyFixtures.token.v1.address,
        creator: legacyFixtures.token.v1.creator,
        name: legacyFixtures.token.v1.name,
        symbol: legacyFixtures.token.v1.symbol,
        decimals: legacyFixtures.token.v1.decimals,
        totalSupply: BigInt(legacyFixtures.token.v1.totalSupply),
        initialSupply: BigInt(legacyFixtures.token.v1.initialSupply),
      },
    });

    // Re-read the row – simulates the migration running again over the same data
    const secondRun = await prisma.token.findUnique({
      where: { id: legacyFixtures.token.v1.id },
    });

    expect(secondRun).not.toBeNull();
    expect(secondRun!.address).toBe(firstRun.address);
    expect(secondRun!.metadataUri).toBe(firstRun.metadataUri);
    expect(secondRun!.burnCount).toBe(firstRun.burnCount);
    expect(secondRun!.totalBurned).toBe(firstRun.totalBurned);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // v2 Fixture: row has burnCount/totalBurned but no metadataUri column.
  // After migration metadataUri must default to null while burn fields survive.
  // ──────────────────────────────────────────────────────────────────────────
  it("v2 row: existing burnCount preserved and absent metadataUri receives null default", async () => {
    const { prisma } = createCompatibilityHarness("empty");

    const migrated = await prisma.token.create({
      data: {
        id: legacyFixtures.token.v2.id,
        address: legacyFixtures.token.v2.address,
        creator: legacyFixtures.token.v2.creator,
        name: legacyFixtures.token.v2.name,
        symbol: legacyFixtures.token.v2.symbol,
        decimals: legacyFixtures.token.v2.decimals,
        totalSupply: BigInt(legacyFixtures.token.v2.totalSupply),
        initialSupply: BigInt(legacyFixtures.token.v2.initialSupply),
        totalBurned: BigInt(legacyFixtures.token.v2.totalBurned),
        burnCount: legacyFixtures.token.v2.burnCount,
        // intentionally omitting metadataUri — v2 schema shape
      },
    });

    // Burn fields must be intact
    expect(migrated.totalBurned).toBe(BigInt(legacyFixtures.token.v2.totalBurned));
    expect(migrated.burnCount).toBe(legacyFixtures.token.v2.burnCount);

    // v2 → current: metadataUri backfills to null
    expect(migrated.metadataUri).toBeNull();
  });

  it("v2 row: zero data loss – core and burn fields survive the migration path", async () => {
    const { prisma } = createCompatibilityHarness("empty");

    await prisma.token.create({
      data: {
        id: legacyFixtures.token.v2.id,
        address: legacyFixtures.token.v2.address,
        creator: legacyFixtures.token.v2.creator,
        name: legacyFixtures.token.v2.name,
        symbol: legacyFixtures.token.v2.symbol,
        decimals: legacyFixtures.token.v2.decimals,
        totalSupply: BigInt(legacyFixtures.token.v2.totalSupply),
        initialSupply: BigInt(legacyFixtures.token.v2.initialSupply),
        totalBurned: BigInt(legacyFixtures.token.v2.totalBurned),
        burnCount: legacyFixtures.token.v2.burnCount,
      },
    });

    const retrieved = await prisma.token.findUnique({
      where: { id: legacyFixtures.token.v2.id },
    });

    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe(legacyFixtures.token.v2.name);
    expect(retrieved!.symbol).toBe(legacyFixtures.token.v2.symbol);
    expect(retrieved!.decimals).toBe(legacyFixtures.token.v2.decimals);
    expect(retrieved!.totalSupply).toBe(
      BigInt(legacyFixtures.token.v2.totalSupply)
    );
    expect(retrieved!.initialSupply).toBe(
      BigInt(legacyFixtures.token.v2.initialSupply)
    );
    expect(retrieved!.totalBurned).toBe(
      BigInt(legacyFixtures.token.v2.totalBurned)
    );
    expect(retrieved!.burnCount).toBe(legacyFixtures.token.v2.burnCount);
  });

  it("v2 row: migration is idempotent – re-reading the migrated row produces stable state", async () => {
    const { prisma } = createCompatibilityHarness("empty");

    const firstRun = await prisma.token.create({
      data: {
        id: legacyFixtures.token.v2.id,
        address: legacyFixtures.token.v2.address,
        creator: legacyFixtures.token.v2.creator,
        name: legacyFixtures.token.v2.name,
        symbol: legacyFixtures.token.v2.symbol,
        decimals: legacyFixtures.token.v2.decimals,
        totalSupply: BigInt(legacyFixtures.token.v2.totalSupply),
        initialSupply: BigInt(legacyFixtures.token.v2.initialSupply),
        totalBurned: BigInt(legacyFixtures.token.v2.totalBurned),
        burnCount: legacyFixtures.token.v2.burnCount,
      },
    });

    const secondRun = await prisma.token.findUnique({
      where: { id: legacyFixtures.token.v2.id },
    });

    expect(secondRun).not.toBeNull();
    expect(secondRun!.metadataUri).toBe(firstRun.metadataUri);
    expect(secondRun!.burnCount).toBe(firstRun.burnCount);
    expect(secondRun!.totalBurned).toBe(firstRun.totalBurned);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // v3 Fixture: row with all fields present (current schema).
  // All values must survive round-trip through the migration harness unchanged.
  // ──────────────────────────────────────────────────────────────────────────
  it("v3 row: all fields present – zero data loss after migration round-trip", async () => {
    const { prisma } = createCompatibilityHarness("empty");

    const migrated = await prisma.token.create({
      data: {
        id: legacyFixtures.token.v3.id,
        address: legacyFixtures.token.v3.address,
        creator: legacyFixtures.token.v3.creator,
        name: legacyFixtures.token.v3.name,
        symbol: legacyFixtures.token.v3.symbol,
        decimals: legacyFixtures.token.v3.decimals,
        totalSupply: BigInt(legacyFixtures.token.v3.totalSupply),
        initialSupply: BigInt(legacyFixtures.token.v3.initialSupply),
        totalBurned: BigInt(legacyFixtures.token.v3.totalBurned),
        burnCount: legacyFixtures.token.v3.burnCount,
        metadataUri: legacyFixtures.token.v3.metadataUri,
      },
    });

    expect(migrated.address).toBe(legacyFixtures.token.v3.address);
    expect(migrated.totalBurned).toBe(BigInt(legacyFixtures.token.v3.totalBurned));
    expect(migrated.burnCount).toBe(legacyFixtures.token.v3.burnCount);
    expect(migrated.metadataUri).toBe(legacyFixtures.token.v3.metadataUri);
  });

  it("v3 row: migration is idempotent – repeated reads return identical state", async () => {
    const { prisma } = createCompatibilityHarness("empty");

    await prisma.token.create({
      data: {
        id: legacyFixtures.token.v3.id,
        address: legacyFixtures.token.v3.address,
        creator: legacyFixtures.token.v3.creator,
        name: legacyFixtures.token.v3.name,
        symbol: legacyFixtures.token.v3.symbol,
        decimals: legacyFixtures.token.v3.decimals,
        totalSupply: BigInt(legacyFixtures.token.v3.totalSupply),
        initialSupply: BigInt(legacyFixtures.token.v3.initialSupply),
        totalBurned: BigInt(legacyFixtures.token.v3.totalBurned),
        burnCount: legacyFixtures.token.v3.burnCount,
        metadataUri: legacyFixtures.token.v3.metadataUri,
      },
    });

    const readOne = await prisma.token.findUnique({
      where: { id: legacyFixtures.token.v3.id },
    });
    const readTwo = await prisma.token.findUnique({
      where: { id: legacyFixtures.token.v3.id },
    });

    expect(readOne).not.toBeNull();
    expect(readTwo).not.toBeNull();
    expect(readTwo!.metadataUri).toBe(readOne!.metadataUri);
    expect(readTwo!.burnCount).toBe(readOne!.burnCount);
    expect(readTwo!.totalBurned).toBe(readOne!.totalBurned);
    expect(readTwo!.address).toBe(readOne!.address);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Cross-version: all three schema versions coexist without key collisions.
  // ──────────────────────────────────────────────────────────────────────────
  it("v1, v2, v3 rows coexist in the same projection without key collisions or data corruption", async () => {
    const { prisma } = createCompatibilityHarness("empty");

    await prisma.token.create({
      data: {
        id: legacyFixtures.token.v1.id,
        address: legacyFixtures.token.v1.address,
        creator: legacyFixtures.token.v1.creator,
        name: legacyFixtures.token.v1.name,
        symbol: legacyFixtures.token.v1.symbol,
        decimals: legacyFixtures.token.v1.decimals,
        totalSupply: BigInt(legacyFixtures.token.v1.totalSupply),
        initialSupply: BigInt(legacyFixtures.token.v1.initialSupply),
      },
    });

    await prisma.token.create({
      data: {
        id: legacyFixtures.token.v2.id,
        address: legacyFixtures.token.v2.address,
        creator: legacyFixtures.token.v2.creator,
        name: legacyFixtures.token.v2.name,
        symbol: legacyFixtures.token.v2.symbol,
        decimals: legacyFixtures.token.v2.decimals,
        totalSupply: BigInt(legacyFixtures.token.v2.totalSupply),
        initialSupply: BigInt(legacyFixtures.token.v2.initialSupply),
        totalBurned: BigInt(legacyFixtures.token.v2.totalBurned),
        burnCount: legacyFixtures.token.v2.burnCount,
      },
    });

    await prisma.token.create({
      data: {
        id: legacyFixtures.token.v3.id,
        address: legacyFixtures.token.v3.address,
        creator: legacyFixtures.token.v3.creator,
        name: legacyFixtures.token.v3.name,
        symbol: legacyFixtures.token.v3.symbol,
        decimals: legacyFixtures.token.v3.decimals,
        totalSupply: BigInt(legacyFixtures.token.v3.totalSupply),
        initialSupply: BigInt(legacyFixtures.token.v3.initialSupply),
        totalBurned: BigInt(legacyFixtures.token.v3.totalBurned),
        burnCount: legacyFixtures.token.v3.burnCount,
        metadataUri: legacyFixtures.token.v3.metadataUri,
      },
    });

    const all = await prisma.token.findMany({});
    expect(all).toHaveLength(3);

    const v1 = all.find((t: { id: string }) => t.id === legacyFixtures.token.v1.id)!;
    const v2 = all.find((t: { id: string }) => t.id === legacyFixtures.token.v2.id)!;
    const v3 = all.find((t: { id: string }) => t.id === legacyFixtures.token.v3.id)!;

    // v1 defaults
    expect(v1.metadataUri).toBeNull();
    expect(v1.burnCount).toBe(0);
    expect(v1.totalBurned).toBe(BigInt(0));

    // v2 values survive, metadataUri null
    expect(v2.metadataUri).toBeNull();
    expect(v2.burnCount).toBe(legacyFixtures.token.v2.burnCount);
    expect(v2.totalBurned).toBe(BigInt(legacyFixtures.token.v2.totalBurned));

    // v3 fully populated
    expect(v3.metadataUri).toBe(legacyFixtures.token.v3.metadataUri);
    expect(v3.burnCount).toBe(legacyFixtures.token.v3.burnCount);
    expect(v3.totalBurned).toBe(BigInt(legacyFixtures.token.v3.totalBurned));

    // No cross-contamination
    expect(v1.name).toBe(legacyFixtures.token.v1.name);
    expect(v2.name).toBe(legacyFixtures.token.v2.name);
    expect(v3.name).toBe(legacyFixtures.token.v3.name);
  });
});
