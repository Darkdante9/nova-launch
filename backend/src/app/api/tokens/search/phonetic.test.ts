import { describe, it, expect } from "vitest";
import { soundex, phoneticMatch } from "./phonetic";

describe("soundex", () => {
  it("returns empty string for empty input", () => {
    expect(soundex("")).toBe("");
  });

  it("pads short words with zeros", () => {
    expect(soundex("A")).toBe("A000");
  });

  it("truncates to 4 characters", () => {
    expect(soundex("LONGERNAME")).toHaveLength(4);
  });

  it("known equivalence: ROBERT and RUPERT share the same code", () => {
    expect(soundex("ROBERT")).toBe(soundex("RUPERT"));
    expect(soundex("ROBERT")).toBe("R163");
  });

  it("STELR and STLR share the same soundex code (typo recovery)", () => {
    // Both should produce the same code since the vowel E is ignored
    expect(soundex("STELR")).toBe(soundex("STLR"));
  });

  it("removes consecutive duplicate codes", () => {
    // PF — both map to '1'; consecutive duplicates are collapsed so only one '1' is emitted
    // PFISTER -> P + (F=1 collapsed with P=1) + S=2 + T=3 + R=6 -> P236
    expect(soundex("PFISTER")).toBe("P236");
    // Verify the collapse: without collapse P+F would give two '1's
    expect(soundex("PFISTER")).not.toBe("P123");
  });

  it("is case-insensitive", () => {
    expect(soundex("robert")).toBe(soundex("ROBERT"));
    expect(soundex("Robert")).toBe(soundex("robert"));
  });

  it("ignores non-alphabetic characters", () => {
    expect(soundex("R0B3RT")).toBe(soundex("RBRT"));
  });

  it("different words produce different codes", () => {
    expect(soundex("SMITH")).not.toBe(soundex("JONES"));
  });
});

describe("phoneticMatch", () => {
  it("returns candidates whose soundex matches the query", () => {
    const results = phoneticMatch("ROBERT", ["RUPERT", "SMITH", "ROBERT"]);
    const values = results.map((r) => r.value);
    expect(values).toContain("RUPERT");
    expect(values).toContain("ROBERT");
    expect(values).not.toContain("SMITH");
  });

  it("gives each matching candidate a score of 1", () => {
    const results = phoneticMatch("ROBERT", ["RUPERT"]);
    expect(results[0].score).toBe(1);
  });

  it("returns empty array when no candidates match", () => {
    const results = phoneticMatch("SMITH", ["JONES", "TAYLOR"]);
    expect(results).toHaveLength(0);
  });

  it("returns empty array for empty candidates list", () => {
    expect(phoneticMatch("TEST", [])).toHaveLength(0);
  });

  it("handles typo recovery for STELR vs STLR", () => {
    const results = phoneticMatch("STELR", ["STLR", "UNRELATED"]);
    const values = results.map((r) => r.value);
    expect(values).toContain("STLR");
    expect(values).not.toContain("UNRELATED");
  });
});
