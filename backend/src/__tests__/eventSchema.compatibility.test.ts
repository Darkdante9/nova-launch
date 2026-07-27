/**
 * Event Schema Compatibility Tests
 *
 * Validates that backend can handle contract event schema changes and that the
 * EventVersioning decoder registry decodes every topic alias (v1, v2, v3) into
 * the same canonical NormalizedEvent struct.
 *
 * DECODER REGISTRY BACKWARD COMPATIBILITY COVERAGE TABLE
 * ─────────────────────────────────────────────────────────────────────────────
 * Event Kind              │ v1 topic alias  │ v2 alias   │ v3/legacy alias   │ Unknown
 * ────────────────────────┼─────────────────┼────────────┼───────────────────┼────────
 * proposal_created        │ prop_cr_v1  ✓   │ prop_cr ✓  │ prop_create ✓     │ ✓
 * vote_cast               │ vote_cs_v1  ✓   │ vote_cs ✓  │ vote_cast ✓       │ ✓
 * proposal_executed       │ prop_ex_v1  ✓   │ prop_ex ✓  │ prop_exec ✓       │ ✓
 * proposal_cancelled      │ prop_ca_v1  ✓   │ prop_ca ✓  │ prop_cancel ✓     │ ✓
 * proposal_status_changed │ prop_st_v1  ✓   │ prop_status ✓                  │ ✓
 * token_created           │ tok_reg     ✓   │ (only one alias)               │ ✓
 * vault_created           │ vlt_cr_v1   ✓   │ (only one alias)               │ ✓
 * vault_claimed           │ vlt_cl_v1   ✓   │ (only one alias)               │ ✓
 * vault_cancelled         │ vlt_cn_v1   ✓   │ (only one alias)               │ ✓
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ContractEventFixture,
  eventFixturesByType,
} from "./fixtures/contractEvents";
import {
  decodeEvent,
  isKnownTopic,
  kindForTopic,
  RawStellarEvent,
  NormalizedEvent,
} from "../services/eventVersioning/decoderRegistry";

// ── Fixture factory ───────────────────────────────────────────────────────────

const TS_ISO = "2025-06-01T12:00:00Z";
const TS_S = Math.floor(new Date(TS_ISO).getTime() / 1000);
const CONTRACT = "CCONTRACT_TEST_12345";
const TOKEN_ADDR = "CTOKEN_TEST_12345678";

function raw(
  topic: string[],
  value: Record<string, unknown>,
  ledger = 6_000_000
): RawStellarEvent {
  return {
    type: "contract",
    ledger,
    ledger_close_time: TS_ISO,
    contract_id: CONTRACT,
    id: `ev-${topic[0]}-${ledger}`,
    paging_token: `pt-${topic[0]}`,
    topic,
    value,
    in_successful_contract_call: true,
    transaction_hash: `tx-${topic[0]}-${ledger}`,
  };
}

// ── Shared event payloads (same data, different topic wrappers) ───────────────

const PROPOSAL_VALUE = {
  proposal_id: 42,
  proposer: "GPROPOSER12345",
  title: "Upgrade treasury policy",
  description: "Increase treasury reserve ratio",
  proposal_type: 0,
  start_time: TS_S,
  end_time: TS_S + 86_400 * 7,
  quorum: 1_000_000,
  threshold: 500_000,
};

const VOTE_VALUE = {
  proposal_id: 42,
  voter: "GVOTER12345",
  support: true,
  weight: "250000",
  reason: "Good proposal",
};

const PROPOSAL_EXEC_VALUE = {
  proposal_id: 42,
  executor: "GEXEC12345",
  success: true,
  return_data: "0x01",
  gas_used: 50_000,
};

const PROPOSAL_CANCEL_VALUE = {
  proposal_id: 42,
  canceller: "GCANCELLER12345",
  reason: "No longer needed",
};

const PROPOSAL_STATUS_VALUE = {
  proposal_id: 42,
  old_status: "active",
  new_status: "passed",
};

const TOKEN_VALUE = {
  creator: "GCREATOR12345",
  name: "Nova Token",
  symbol: "NOVA",
  decimals: 7,
  initial_supply: "1000000000000",
};

const VAULT_CREATE_VALUE = {
  stream_id: 99,
  creator: "GCREATOR12345",
  recipient: "GRECIPIENT12345",
  amount: "500000000",
  has_metadata: true,
};

const VAULT_CLAIM_VALUE = {
  stream_id: 99,
  recipient: "GRECIPIENT12345",
  amount: "500000000",
};

const VAULT_CANCEL_VALUE = {
  stream_id: 99,
  canceller: "GCREATOR12345",
  remaining_amount: "250000000",
};

// ── v1, v2, v3 fixtures per event family ─────────────────────────────────────
//
// v1  = `*_v1`-suffixed Stellar topic strings  (first contract deployment)
// v2  = abbreviated topic strings without suffix (second deployment)
// v3  = legacy-alias topic strings              (historical / third variant)

const GOVERNANCE_FIXTURES = {
  proposal_created: {
    v1: raw(["prop_cr_v1", TOKEN_ADDR], PROPOSAL_VALUE),
    v2: raw(["prop_cr", TOKEN_ADDR], PROPOSAL_VALUE),
    v3: raw(["prop_create", TOKEN_ADDR], PROPOSAL_VALUE),
  },
  vote_cast: {
    v1: raw(["vote_cs_v1", TOKEN_ADDR], VOTE_VALUE),
    v2: raw(["vote_cs", TOKEN_ADDR], VOTE_VALUE),
    v3: raw(["vote_cast", TOKEN_ADDR], VOTE_VALUE),
  },
  proposal_executed: {
    v1: raw(["prop_ex_v1", TOKEN_ADDR], PROPOSAL_EXEC_VALUE),
    v2: raw(["prop_ex", TOKEN_ADDR], PROPOSAL_EXEC_VALUE),
    v3: raw(["prop_exec", TOKEN_ADDR], PROPOSAL_EXEC_VALUE),
  },
  proposal_cancelled: {
    v1: raw(["prop_ca_v1", TOKEN_ADDR], PROPOSAL_CANCEL_VALUE),
    v2: raw(["prop_ca", TOKEN_ADDR], PROPOSAL_CANCEL_VALUE),
    v3: raw(["prop_cancel", TOKEN_ADDR], PROPOSAL_CANCEL_VALUE),
  },
  proposal_status_changed: {
    v1: raw(["prop_st_v1", TOKEN_ADDR], PROPOSAL_STATUS_VALUE),
    v2: raw(["prop_status", TOKEN_ADDR], PROPOSAL_STATUS_VALUE),
  },
};

const TOKEN_FIXTURES = {
  token_created: {
    v1: raw(["tok_reg", TOKEN_ADDR], TOKEN_VALUE),
  },
};

const STREAM_FIXTURES = {
  vault_created: {
    v1: raw(["vlt_cr_v1", TOKEN_ADDR], VAULT_CREATE_VALUE),
  },
  vault_claimed: {
    v1: raw(["vlt_cl_v1", TOKEN_ADDR], VAULT_CLAIM_VALUE),
  },
  vault_cancelled: {
    v1: raw(["vlt_cn_v1", TOKEN_ADDR], VAULT_CANCEL_VALUE),
  },
};

// ── Canonical struct comparison helpers ──────────────────────────────────────

function omitMetaFields(
  event: NormalizedEvent
): Omit<NormalizedEvent, "txHash" | "ledger" | "timestamp" | "contractId"> {
  const { txHash: _tx, ledger: _l, timestamp: _ts, contractId: _c, ...rest } =
    event as any;
  return rest;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Existing contract event schema validation (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_SCHEMAS = {
  init: {
    topic: ["init"],
    requiredFields: ["admin", "treasury", "base_fee", "metadata_fee"],
    optionalFields: [],
  },
  tok_reg: {
    topic: ["tok_reg", "<token_address>"],
    requiredFields: ["creator"],
    optionalFields: [],
  },
  adm_xfer: {
    topic: ["adm_xfer"],
    requiredFields: ["old_admin", "new_admin"],
    optionalFields: [],
  },
  adm_prop: {
    topic: ["adm_prop"],
    requiredFields: ["current_admin", "proposed_admin"],
    optionalFields: [],
  },
  adm_burn: {
    topic: ["adm_burn", "<token_address>"],
    requiredFields: ["admin", "from", "amount"],
    optionalFields: [],
  },
  tok_burn: {
    topic: ["tok_burn", "<token_address>"],
    requiredFields: ["amount"],
    optionalFields: ["from", "burner"],
  },
  fee_upd: {
    topic: ["fee_upd"],
    requiredFields: ["base_fee", "metadata_fee"],
    optionalFields: [],
  },
  pause: {
    topic: ["pause"],
    requiredFields: ["admin"],
    optionalFields: [],
  },
  unpause: {
    topic: ["unpause"],
    requiredFields: ["admin"],
    optionalFields: [],
  },
  clawback: {
    topic: ["clawback", "<token_address>"],
    requiredFields: ["admin", "enabled"],
    optionalFields: [],
  },
};

describe("Event Schema Compatibility", () => {
  describe("Schema Validation", () => {
    it("should validate init event schema", () => {
      const event = eventFixturesByType.init;
      const schema = EVENT_SCHEMAS.init;
      expect(event.topic[0]).toBe(schema.topic[0]);
      schema.requiredFields.forEach((field) => {
        expect(event.value).toHaveProperty(field);
      });
    });

    it("should validate tok_reg event schema", () => {
      const event = eventFixturesByType.tok_reg;
      const schema = EVENT_SCHEMAS.tok_reg;
      expect(event.topic[0]).toBe(schema.topic[0]);
      expect(event.topic.length).toBeGreaterThanOrEqual(2);
      schema.requiredFields.forEach((field) => {
        expect(event.value).toHaveProperty(field);
      });
    });

    it("should validate adm_xfer event schema", () => {
      const event = eventFixturesByType.adm_xfer;
      const schema = EVENT_SCHEMAS.adm_xfer;
      expect(event.topic[0]).toBe(schema.topic[0]);
      schema.requiredFields.forEach((field) => {
        expect(event.value).toHaveProperty(field);
      });
    });

    it("should validate adm_prop event schema (new in v2)", () => {
      const event = eventFixturesByType.adm_prop;
      const schema = EVENT_SCHEMAS.adm_prop;
      expect(event.topic[0]).toBe(schema.topic[0]);
      schema.requiredFields.forEach((field) => {
        expect(event.value).toHaveProperty(field);
      });
    });

    it("should validate adm_burn event schema", () => {
      const event = eventFixturesByType.adm_burn;
      const schema = EVENT_SCHEMAS.adm_burn;
      expect(event.topic[0]).toBe(schema.topic[0]);
      expect(event.topic.length).toBeGreaterThanOrEqual(2);
      schema.requiredFields.forEach((field) => {
        expect(event.value).toHaveProperty(field);
      });
    });

    it("should validate tok_burn event schema", () => {
      const event = eventFixturesByType.tok_burn;
      const schema = EVENT_SCHEMAS.tok_burn;
      expect(event.topic[0]).toBe(schema.topic[0]);
      expect(event.topic.length).toBeGreaterThanOrEqual(2);
      schema.requiredFields.forEach((field) => {
        expect(event.value).toHaveProperty(field);
      });
    });

    it("should validate fee_upd event schema", () => {
      const event = eventFixturesByType.fee_upd;
      const schema = EVENT_SCHEMAS.fee_upd;
      expect(event.topic[0]).toBe(schema.topic[0]);
      schema.requiredFields.forEach((field) => {
        expect(event.value).toHaveProperty(field);
      });
    });

    it("should validate pause event schema", () => {
      const event = eventFixturesByType.pause;
      const schema = EVENT_SCHEMAS.pause;
      expect(event.topic[0]).toBe(schema.topic[0]);
      schema.requiredFields.forEach((field) => {
        expect(event.value).toHaveProperty(field);
      });
    });

    it("should validate unpause event schema", () => {
      const event = eventFixturesByType.unpause;
      const schema = EVENT_SCHEMAS.unpause;
      expect(event.topic[0]).toBe(schema.topic[0]);
      schema.requiredFields.forEach((field) => {
        expect(event.value).toHaveProperty(field);
      });
    });

    it("should validate clawback event schema", () => {
      const event = eventFixturesByType.clawback;
      const schema = EVENT_SCHEMAS.clawback;
      expect(event.topic[0]).toBe(schema.topic[0]);
      expect(event.topic.length).toBeGreaterThanOrEqual(2);
      schema.requiredFields.forEach((field) => {
        expect(event.value).toHaveProperty(field);
      });
    });
  });

  describe("Backward Compatibility", () => {
    it("should handle events with additional fields (forward compatibility)", () => {
      const eventWithExtraFields: ContractEventFixture = {
        ...eventFixturesByType.tok_reg,
        value: {
          ...eventFixturesByType.tok_reg.value,
          new_field_v2: "some_value",
          another_new_field: 12345,
        },
      };
      const schema = EVENT_SCHEMAS.tok_reg;
      schema.requiredFields.forEach((field) => {
        expect(eventWithExtraFields.value).toHaveProperty(field);
      });
      expect(eventWithExtraFields.value.new_field_v2).toBe("some_value");
    });

    it("should handle events with missing optional fields", () => {
      const eventWithoutOptionals: ContractEventFixture = {
        ...eventFixturesByType.tok_burn,
        value: { amount: "1000000000" },
      };
      const schema = EVENT_SCHEMAS.tok_burn;
      schema.requiredFields.forEach((field) => {
        expect(eventWithoutOptionals.value).toHaveProperty(field);
      });
      expect(eventWithoutOptionals.value.from).toBeUndefined();
      expect(eventWithoutOptionals.value.burner).toBeUndefined();
    });
  });

  describe("Data Type Compatibility", () => {
    it("should handle numeric values as strings", () => {
      const event = eventFixturesByType.adm_burn;
      expect(typeof event.value.amount).toBe("string");
      expect(event.value.amount).toMatch(/^\d+$/);
    });

    it("should handle boolean values correctly", () => {
      const event = eventFixturesByType.clawback;
      expect(typeof event.value.enabled).toBe("boolean");
    });

    it("should handle address values as strings", () => {
      const event = eventFixturesByType.adm_xfer;
      expect(typeof event.value.old_admin).toBe("string");
      expect(typeof event.value.new_admin).toBe("string");
    });
  });

  describe("Event Metadata", () => {
    it("should have required metadata fields", () => {
      Object.values(eventFixturesByType).forEach((event) => {
        expect(event).toHaveProperty("type");
        expect(event).toHaveProperty("ledger");
        expect(event).toHaveProperty("ledger_close_time");
        expect(event).toHaveProperty("contract_id");
        expect(event).toHaveProperty("transaction_hash");
        expect(event).toHaveProperty("in_successful_contract_call");
      });
    });

    it("should have valid transaction hashes", () => {
      Object.values(eventFixturesByType).forEach((event) => {
        expect(event.transaction_hash).toBeTruthy();
        expect(typeof event.transaction_hash).toBe("string");
        expect(event.transaction_hash.length).toBeGreaterThan(0);
      });
    });

    it("should have valid ledger numbers", () => {
      Object.values(eventFixturesByType).forEach((event) => {
        expect(typeof event.ledger).toBe("number");
        expect(event.ledger).toBeGreaterThan(0);
      });
    });
  });

  describe("Schema Evolution", () => {
    it("should document schema version compatibility", () => {
      const supportedSchemas = Object.keys(EVENT_SCHEMAS);
      expect(supportedSchemas).toContain("init");
      expect(supportedSchemas).toContain("tok_reg");
      expect(supportedSchemas).toContain("adm_xfer");
      expect(supportedSchemas).toContain("adm_prop");
      expect(supportedSchemas).toContain("adm_burn");
      expect(supportedSchemas).toContain("tok_burn");
      expect(supportedSchemas).toContain("fee_upd");
      expect(supportedSchemas).toContain("pause");
      expect(supportedSchemas).toContain("unpause");
      expect(supportedSchemas).toContain("clawback");
    });

    it("should handle schema version transitions", () => {
      const oldAdminTransfer = eventFixturesByType.adm_xfer;
      const newAdminProposal = eventFixturesByType.adm_prop;
      expect(oldAdminTransfer.topic[0]).toBe("adm_xfer");
      expect(newAdminProposal.topic[0]).toBe("adm_prop");
      expect(oldAdminTransfer.value.old_admin).toBeDefined();
      expect(oldAdminTransfer.value.new_admin).toBeDefined();
      expect(newAdminProposal.value.current_admin).toBeDefined();
      expect(newAdminProposal.value.proposed_admin).toBeDefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Decoder Registry Backward Compatibility
// ─────────────────────────────────────────────────────────────────────────────

describe("Decoder Registry — Backward Compatibility Across Schema Versions", () => {

  // ── Registry key resolution ──────────────────────────────────────────────

  describe("registry returns the correct decoder for each version key", () => {
    it("maps all governance proposal_created aliases to 'proposal_created'", () => {
      expect(kindForTopic("prop_cr_v1")).toBe("proposal_created");
      expect(kindForTopic("prop_cr")).toBe("proposal_created");
      expect(kindForTopic("prop_create")).toBe("proposal_created");
    });

    it("maps all vote_cast aliases to 'vote_cast'", () => {
      expect(kindForTopic("vote_cs_v1")).toBe("vote_cast");
      expect(kindForTopic("vote_cs")).toBe("vote_cast");
      expect(kindForTopic("vote_cast")).toBe("vote_cast");
    });

    it("maps all proposal_executed aliases to 'proposal_executed'", () => {
      expect(kindForTopic("prop_ex_v1")).toBe("proposal_executed");
      expect(kindForTopic("prop_ex")).toBe("proposal_executed");
      expect(kindForTopic("prop_exec")).toBe("proposal_executed");
    });

    it("maps all proposal_cancelled aliases to 'proposal_cancelled'", () => {
      expect(kindForTopic("prop_ca_v1")).toBe("proposal_cancelled");
      expect(kindForTopic("prop_ca")).toBe("proposal_cancelled");
      expect(kindForTopic("prop_cancel")).toBe("proposal_cancelled");
    });

    it("maps all proposal_status_changed aliases to 'proposal_status_changed'", () => {
      expect(kindForTopic("prop_st_v1")).toBe("proposal_status_changed");
      expect(kindForTopic("prop_status")).toBe("proposal_status_changed");
    });

    it("maps token event topics to their canonical kinds", () => {
      expect(kindForTopic("tok_reg")).toBe("token_created");
      expect(kindForTopic("tok_burn")).toBe("token_burned");
      expect(kindForTopic("adm_burn")).toBe("token_admin_burned");
      expect(kindForTopic("tok_meta")).toBe("token_metadata_updated");
    });

    it("maps stream/vault v1 topics to their canonical kinds", () => {
      expect(kindForTopic("vlt_cr_v1")).toBe("vault_created");
      expect(kindForTopic("vlt_cl_v1")).toBe("vault_claimed");
      expect(kindForTopic("vlt_cn_v1")).toBe("vault_cancelled");
      expect(kindForTopic("vlt_md_v1")).toBe("vault_metadata_updated");
    });

    it("returns null for unknown topics", () => {
      expect(kindForTopic("UNKNOWN_TOPIC_XYZ")).toBeNull();
      expect(kindForTopic("")).toBeNull();
      expect(kindForTopic("v3_future_topic")).toBeNull();
    });

    it("isKnownTopic returns false for unknown topics", () => {
      expect(isKnownTopic("UNKNOWN_TOPIC_XYZ")).toBe(false);
      expect(isKnownTopic("")).toBe(false);
    });
  });

  // ── Governance: v1 / v2 / v3 decode to same canonical struct ────────────

  describe("Governance events decode identically across all version aliases", () => {
    it("proposal_created: v1, v2, v3 fixtures produce identical canonical structs", () => {
      const { v1, v2, v3 } = GOVERNANCE_FIXTURES.proposal_created;
      const decoded = [decodeEvent(v1), decodeEvent(v2), decodeEvent(v3)].map(
        omitMetaFields
      );

      expect(decoded[0].kind).toBe("proposal_created");
      expect(decoded[1]).toEqual(decoded[0]);
      expect(decoded[2]).toEqual(decoded[0]);
    });

    it("vote_cast: v1, v2, v3 fixtures produce identical canonical structs", () => {
      const { v1, v2, v3 } = GOVERNANCE_FIXTURES.vote_cast;
      const decoded = [decodeEvent(v1), decodeEvent(v2), decodeEvent(v3)].map(
        omitMetaFields
      );

      expect(decoded[0].kind).toBe("vote_cast");
      expect(decoded[1]).toEqual(decoded[0]);
      expect(decoded[2]).toEqual(decoded[0]);
    });

    it("proposal_executed: v1, v2, v3 fixtures produce identical canonical structs", () => {
      const { v1, v2, v3 } = GOVERNANCE_FIXTURES.proposal_executed;
      const decoded = [decodeEvent(v1), decodeEvent(v2), decodeEvent(v3)].map(
        omitMetaFields
      );

      expect(decoded[0].kind).toBe("proposal_executed");
      expect(decoded[1]).toEqual(decoded[0]);
      expect(decoded[2]).toEqual(decoded[0]);
    });

    it("proposal_cancelled: v1, v2, v3 fixtures produce identical canonical structs", () => {
      const { v1, v2, v3 } = GOVERNANCE_FIXTURES.proposal_cancelled;
      const decoded = [decodeEvent(v1), decodeEvent(v2), decodeEvent(v3)].map(
        omitMetaFields
      );

      expect(decoded[0].kind).toBe("proposal_cancelled");
      expect(decoded[1]).toEqual(decoded[0]);
      expect(decoded[2]).toEqual(decoded[0]);
    });

    it("proposal_status_changed: v1 and v2 fixtures produce identical canonical structs", () => {
      const { v1, v2 } = GOVERNANCE_FIXTURES.proposal_status_changed;
      const d1 = omitMetaFields(decodeEvent(v1));
      const d2 = omitMetaFields(decodeEvent(v2));

      expect(d1.kind).toBe("proposal_status_changed");
      expect(d2).toEqual(d1);
    });

    it("decoded proposal_created struct contains all required fields", () => {
      const decoded = decodeEvent(GOVERNANCE_FIXTURES.proposal_created.v1) as any;
      expect(decoded.kind).toBe("proposal_created");
      expect(decoded.proposalId).toBe(42);
      expect(decoded.proposer).toBe("GPROPOSER12345");
      expect(decoded.title).toBe("Upgrade treasury policy");
      expect(decoded.startTime).toBeInstanceOf(Date);
      expect(decoded.endTime).toBeInstanceOf(Date);
      expect(decoded.quorum).toBe("1000000");
      expect(decoded.threshold).toBe("500000");
    });
  });

  // ── Token events ─────────────────────────────────────────────────────────

  describe("Token events decode to canonical struct", () => {
    it("token_created (tok_reg v1) decodes correctly", () => {
      const decoded = decodeEvent(TOKEN_FIXTURES.token_created.v1) as any;
      expect(decoded.kind).toBe("token_created");
      expect(decoded.tokenAddress).toBe(TOKEN_ADDR);
      expect(decoded.creator).toBe("GCREATOR12345");
      expect(decoded.name).toBe("Nova Token");
      expect(decoded.symbol).toBe("NOVA");
      expect(decoded.decimals).toBe(7);
      expect(decoded.initialSupply).toBe("1000000000000");
    });

    it("token_created struct matches snapshot regardless of ledger number", () => {
      const fixture1 = raw(["tok_reg", TOKEN_ADDR], TOKEN_VALUE, 5_000_000);
      const fixture2 = raw(["tok_reg", TOKEN_ADDR], TOKEN_VALUE, 6_000_001);

      const d1 = omitMetaFields(decodeEvent(fixture1));
      const d2 = omitMetaFields(decodeEvent(fixture2));

      expect(d1).toEqual(d2);
    });
  });

  // ── Stream / Vault events ─────────────────────────────────────────────────

  describe("Stream/Vault events decode to canonical struct", () => {
    it("vault_created (vlt_cr_v1) decodes correctly", () => {
      const decoded = decodeEvent(STREAM_FIXTURES.vault_created.v1) as any;
      expect(decoded.kind).toBe("vault_created");
      expect(decoded.streamId).toBe(99);
      expect(decoded.creator).toBe("GCREATOR12345");
      expect(decoded.recipient).toBe("GRECIPIENT12345");
      expect(decoded.amount).toBe("500000000");
      expect(decoded.hasMetadata).toBe(true);
    });

    it("vault_claimed (vlt_cl_v1) decodes correctly", () => {
      const decoded = decodeEvent(STREAM_FIXTURES.vault_claimed.v1) as any;
      expect(decoded.kind).toBe("vault_claimed");
      expect(decoded.streamId).toBe(99);
      expect(decoded.recipient).toBe("GRECIPIENT12345");
      expect(decoded.amount).toBe("500000000");
    });

    it("vault_cancelled (vlt_cn_v1) decodes correctly", () => {
      const decoded = decodeEvent(STREAM_FIXTURES.vault_cancelled.v1) as any;
      expect(decoded.kind).toBe("vault_cancelled");
      expect(decoded.streamId).toBe(99);
      expect(decoded.canceller).toBe("GCREATOR12345");
      expect(decoded.remainingAmount).toBe("250000000");
    });

    it("vault_created canonical struct is identical whether stream_id is in value or topic", () => {
      const viaValue = raw(
        ["vlt_cr_v1"],
        { ...VAULT_CREATE_VALUE, stream_id: 7 }
      );
      const viaTopic = raw(
        ["vlt_cr_v1", "7"],
        { ...VAULT_CREATE_VALUE, stream_id: undefined as any }
      );

      const d1 = omitMetaFields(decodeEvent(viaValue)) as any;
      const d2 = omitMetaFields(decodeEvent(viaTopic)) as any;

      expect(d1.kind).toBe("vault_created");
      expect(d2.kind).toBe("vault_created");
      expect(d1.streamId).toBe(d2.streamId);
    });
  });

  // ── Unknown version → typed UnknownSchemaVersion indicator ──────────────

  describe("unknown topic produces typed UnknownSchemaVersion indicator", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("returns { kind: 'unknown' } for unrecognized topic — does not throw", () => {
      const event = raw(["unknown_topic_xyz"], { foo: "bar" });
      const decoded = decodeEvent(event);
      expect(decoded.kind).toBe("unknown");
    });

    it("unknown event preserves base fields (txHash, ledger, contractId)", () => {
      const event = raw(["future_event_v99"], { data: 1 });
      const decoded = decodeEvent(event) as any;
      expect(decoded.kind).toBe("unknown");
      expect(decoded.contractId).toBe(CONTRACT);
      expect(decoded.ledger).toBe(6_000_000);
      expect(decoded.txHash).toBe("tx-future_event_v99-6000000");
    });

    it("emits a console.warn for unknown topics", () => {
      const event = raw(["completely_unknown"], { x: 1 });
      decodeEvent(event);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain("completely_unknown");
    });

    it("empty topic array returns { kind: 'unknown' } — does not throw", () => {
      const event = raw([], {});
      const decoded = decodeEvent(event);
      expect(decoded.kind).toBe("unknown");
    });

    it("isKnownTopic returns false for unknown topics", () => {
      expect(isKnownTopic("UNKNOWN_FUTURE_V9")).toBe(false);
    });
  });

  // ── In-flight upgrade simulation ─────────────────────────────────────────
  //
  // Simulates an in-progress decoder upgrade: a ledger stream that starts
  // with v1-format events and switches to v2-format events mid-stream.
  // All events must decode to the same canonical shape.

  describe("simulates decoder upgrade while events are in-flight", () => {
    it("mixed v1/v2/v3 governance stream decodes to uniform canonical structs", () => {
      // Sequence: v1 events from before upgrade, v2 after, v3 from replay of old history
      const stream: RawStellarEvent[] = [
        raw(["prop_cr_v1", TOKEN_ADDR], PROPOSAL_VALUE, 5_000_000), // pre-upgrade v1
        raw(["vote_cs_v1", TOKEN_ADDR], VOTE_VALUE, 5_000_100),     // pre-upgrade v1
        raw(["prop_cr", TOKEN_ADDR], PROPOSAL_VALUE, 5_000_200),    // post-upgrade v2
        raw(["vote_cs", TOKEN_ADDR], VOTE_VALUE, 5_000_300),        // post-upgrade v2
        raw(["prop_create", TOKEN_ADDR], PROPOSAL_VALUE, 5_000_400),// legacy replay v3
        raw(["vote_cast", TOKEN_ADDR], VOTE_VALUE, 5_000_500),      // legacy replay v3
      ];

      const decoded = stream.map(decodeEvent);

      // No events should be 'unknown' — all are recognized
      decoded.forEach((e) => {
        expect(e.kind).not.toBe("unknown");
      });

      // Governance events pair-wise: v1 == v2 == v3 for proposals
      const proposals = decoded.filter((e) => e.kind === "proposal_created");
      const votes = decoded.filter((e) => e.kind === "vote_cast");
      expect(proposals).toHaveLength(3);
      expect(votes).toHaveLength(3);

      // All proposal decodes produce the same canonical payload
      const [p1, p2, p3] = proposals.map(omitMetaFields);
      expect(p2).toEqual(p1);
      expect(p3).toEqual(p1);

      // All vote decodes produce the same canonical payload
      const [v1d, v2d, v3d] = votes.map(omitMetaFields);
      expect(v2d).toEqual(v1d);
      expect(v3d).toEqual(v1d);
    });

    it("mixed stream with unknown in-flight events surfaces them without blocking others", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const stream: RawStellarEvent[] = [
        raw(["prop_cr_v1", TOKEN_ADDR], PROPOSAL_VALUE, 5_000_000),
        raw(["future_v4_event"], { proposal_id: 99 }, 5_000_100), // unknown
        raw(["prop_cr", TOKEN_ADDR], PROPOSAL_VALUE, 5_000_200),
      ];

      const decoded = stream.map(decodeEvent);

      expect(decoded[0].kind).toBe("proposal_created");
      expect(decoded[1].kind).toBe("unknown"); // surfaced, not thrown
      expect(decoded[2].kind).toBe("proposal_created");

      // v1 and v2 proposal payloads are identical
      expect(omitMetaFields(decoded[0])).toEqual(omitMetaFields(decoded[2]));

      warnSpy.mockRestore();
    });
  });
});
