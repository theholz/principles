import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { loadProcessSpec } from "../../src/factory/loadSpec";

const seedPath = path.join(__dirname, "..", "..", "seeds", "factory-meta", "process-spec.json");
const seedJson = fs.readFileSync(seedPath, "utf8");

/** Deep-clone the seed, apply one mutation, re-serialize. */
const corrupt = (mutate: (spec: any) => void): string => {
  const clone = JSON.parse(seedJson);
  mutate(clone);
  return JSON.stringify(clone);
};

describe("loadProcessSpec", () => {
  it("parses the hand-authored seed spec clean", () => {
    const spec = loadProcessSpec(seedJson);
    expect(spec.meta.name).toBe("process-factory-meta");
    expect(spec.meta.scalingTier).toBe("medium");
    expect(spec.assessment.triageVerdict.verdict).toBe("create_new");
    expect(spec.foundations.truths).toHaveLength(3);
    expect(spec.contract.ctqs).toHaveLength(3);
    expect(spec.contract.baseline).toBe("unmeasured");
    expect(spec.contract.governancePhase).toBe("shadow");
    expect(spec.roles).toHaveLength(1);
    expect(spec.artifacts.map((a) => a.kind)).toEqual(["skill", "gate", "hook"]);
    expect(spec.knobs[0].default).toBe(20);
    expect(spec.methodologyDeps).toEqual(["first-principles", "theory-of-constraints", "dmaic"]);
    expect(spec.registryEntry.targets).toEqual([]);
  });

  it("every seed artifact cites a truth or the constraint (seed honesty, not loader logic)", () => {
    // Shape-level sanity on the fixture Tasks 2-3 will build on; the semantic
    // validator itself is Task 2's pv-traceability.
    const spec = loadProcessSpec(seedJson);
    for (const a of spec.artifacts) {
      expect(a.traceability.truthIds.length + a.traceability.constraintIds.length).toBeGreaterThan(0);
    }
  });

  it("rejects input that is not JSON at all", () => {
    expect(() => loadProcessSpec("not json {")).toThrow(/not valid JSON/);
  });

  it("rejects a bad triage verdict enum, naming the path", () => {
    const bad = corrupt((s) => { s.assessment.triageVerdict.verdict = "vibes"; });
    expect(() => loadProcessSpec(bad)).toThrow(/assessment\.triageVerdict\.verdict/);
  });

  it("rejects a missing contract.decisionRule, naming the path", () => {
    const bad = corrupt((s) => { delete s.contract.decisionRule; });
    expect(() => loadProcessSpec(bad)).toThrow(/contract\.decisionRule/);
  });

  it("rejects an artifact with an invalid kind, naming the path", () => {
    const bad = corrupt((s) => { s.artifacts[0].kind = "vibe-check"; });
    expect(() => loadProcessSpec(bad)).toThrow(/artifacts\.0\.kind/);
  });

  it("rejects an artifact missing its traceability block entirely (shape, not semantics)", () => {
    const bad = corrupt((s) => { delete s.artifacts[1].traceability; });
    expect(() => loadProcessSpec(bad)).toThrow(/artifacts\.1\.traceability/);
  });

  it("rejects a knob with non-numeric min/max where numbers are expected", () => {
    const bad = corrupt((s) => { s.knobs[0].range = { min: "10", max: 100 }; });
    expect(() => loadProcessSpec(bad)).toThrow(/knobs\.0\.range/);
  });

  it("accepts a knob with an enum-strings range", () => {
    const ok = corrupt((s) => {
      s.knobs[0].range = ["weekly", "daily"];
      s.knobs[0].default = "weekly";
    });
    expect(loadProcessSpec(ok).knobs[0].range).toEqual(["weekly", "daily"]);
  });

  it("rejects an invalid governancePhase", () => {
    const bad = corrupt((s) => { s.contract.governancePhase = "yolo"; });
    expect(() => loadProcessSpec(bad)).toThrow(/contract\.governancePhase/);
  });

  it("rejects unknown keys — the schema is closed", () => {
    const bad = corrupt((s) => { s.meta.vendor = "definitely-not-hardcoded"; });
    expect(() => loadProcessSpec(bad)).toThrow(/meta/);
  });

  it("lists every offending path when multiple corruptions are present", () => {
    const bad = corrupt((s) => {
      s.meta.scalingTier = "galactic";
      delete s.contract.decisionRule;
    });
    let message = "";
    try {
      loadProcessSpec(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("meta.scalingTier");
    expect(message).toContain("contract.decisionRule");
  });
});
