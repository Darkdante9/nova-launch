/**
 * Tests for the event-schemas -> TypeScript codegen core logic (#1406).
 *
 * These test the exported pure functions directly rather than shelling out to
 * `tsx scripts/generate-event-types.ts`, per the script's own design (the CLI
 * entry point at the bottom of the file is gated behind an `import.meta`/
 * `process.argv` check and is not exercised here).
 */

import { describe, it, expect } from "vitest";
import {
  jsonSchemaTypeToTs,
  eventTypeToInterfaceName,
  generateInterfaceForSchema,
  generateEventTypesFile,
  type EventJsonSchema,
} from "./generate-event-types";

describe("jsonSchemaTypeToTs", () => {
  it("maps string", () => {
    expect(jsonSchemaTypeToTs({ type: "string" })).toBe("string");
  });

  it("maps integer and number to TS number", () => {
    expect(jsonSchemaTypeToTs({ type: "integer" })).toBe("number");
    expect(jsonSchemaTypeToTs({ type: "number" })).toBe("number");
  });

  it("maps boolean", () => {
    expect(jsonSchemaTypeToTs({ type: "boolean" })).toBe("boolean");
  });

  it("maps a union of types (array form)", () => {
    expect(jsonSchemaTypeToTs({ type: ["string", "null"] })).toBe("string | null");
  });

  it("maps const to a literal type", () => {
    expect(jsonSchemaTypeToTs({ const: 1 })).toBe("1");
    expect(jsonSchemaTypeToTs({ const: "fixed" })).toBe('"fixed"');
  });

  it("maps enum to a union of literals", () => {
    expect(jsonSchemaTypeToTs({ enum: ["a", "b"] })).toBe('"a" | "b"');
  });

  it("falls back to unknown for an untyped property", () => {
    expect(jsonSchemaTypeToTs({})).toBe("unknown");
  });
});

describe("eventTypeToInterfaceName", () => {
  it("converts a dotted event type to a PascalCase interface name", () => {
    expect(eventTypeToInterfaceName("token.deployed")).toBe("TokenDeployedEventPayload");
  });

  it("handles multi-segment dotted event types", () => {
    expect(eventTypeToInterfaceName("governance.proposal.statusChanged")).toBe(
      "GovernanceProposalStatusChangedEventPayload"
    );
  });
});

describe("generateInterfaceForSchema", () => {
  const sampleSchema: EventJsonSchema = {
    title: "SampleEvent",
    description: "A sample event for codegen testing.",
    type: "object",
    schemaVersion: 1,
    eventType: "sample.event",
    properties: {
      schemaVersion: { const: 1, description: "Schema version." },
      id: { type: "string", description: "Identifier." },
      count: { type: "integer" },
      tag: { type: ["string", "null"] },
    },
    required: ["id", "count"],
    additionalProperties: false,
  };

  it("generates an interface with required fields non-optional and others optional", () => {
    const output = generateInterfaceForSchema(sampleSchema);

    expect(output).toContain("export interface SampleEventEventPayload {");
    expect(output).toContain("id: string;");
    expect(output).toContain("count: number;");
    // schemaVersion is not in `required`, so it should be marked optional.
    expect(output).toContain("schemaVersion?: 1;");
    expect(output).toContain("tag?: string | null;");
  });

  it("includes the schema description and event type in a doc comment", () => {
    const output = generateInterfaceForSchema(sampleSchema);
    expect(output).toContain("A sample event for codegen testing.");
    expect(output).toContain("Event type: `sample.event`");
  });

  it("generates a union type plus one interface per branch for anyOf schemas", () => {
    const anyOfSchema: EventJsonSchema = {
      title: "MultiShapeEvent",
      description: "An event with two known shapes.",
      type: "object",
      schemaVersion: 1,
      eventType: "multi.shape",
      anyOf: [
        {
          type: "object",
          description: "Shape A",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        {
          type: "object",
          description: "Shape B",
          properties: { b: { type: "integer" } },
          required: ["b"],
        },
      ],
    };

    const output = generateInterfaceForSchema(anyOfSchema);

    expect(output).toContain("export interface MultiShapeEventPayloadVariant1 {");
    expect(output).toContain("a: string;");
    expect(output).toContain("export interface MultiShapeEventPayloadVariant2 {");
    expect(output).toContain("b: number;");
    expect(output).toContain(
      "export type MultiShapeEventPayload = MultiShapeEventPayloadVariant1 | MultiShapeEventPayloadVariant2;"
    );
  });
});

describe("generateEventTypesFile", () => {
  const schemaA: EventJsonSchema = {
    title: "EventA",
    type: "object",
    schemaVersion: 1,
    eventType: "a.event",
    properties: { x: { type: "string" } },
    required: ["x"],
  };

  const schemaB: EventJsonSchema = {
    title: "EventB",
    type: "object",
    schemaVersion: 2,
    eventType: "b.event",
    properties: { y: { type: "integer" } },
    required: ["y"],
  };

  it("emits the auto-generated header warning", () => {
    const output = generateEventTypesFile([schemaA, schemaB]);
    expect(output).toContain("AUTO-GENERATED FILE");
    expect(output).toContain("DO NOT EDIT BY HAND");
  });

  it("emits one interface per schema, sorted by event type", () => {
    const output = generateEventTypesFile([schemaB, schemaA]);
    const indexA = output.indexOf("export interface AEventEventPayload");
    const indexB = output.indexOf("export interface BEventEventPayload");
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThan(indexA); // "a.event" sorts before "b.event"
  });

  it("emits an EventPayloadMap keyed by event type", () => {
    const output = generateEventTypesFile([schemaA, schemaB]);
    expect(output).toContain("export interface EventPayloadMap {");
    expect(output).toContain('"a.event": AEventEventPayload;');
    expect(output).toContain('"b.event": BEventEventPayload;');
  });

  it("emits an EVENT_SCHEMA_VERSIONS const map with the correct version numbers", () => {
    const output = generateEventTypesFile([schemaA, schemaB]);
    expect(output).toContain("export const EVENT_SCHEMA_VERSIONS = {");
    expect(output).toContain('"a.event": 1,');
    expect(output).toContain('"b.event": 2,');
  });
});
