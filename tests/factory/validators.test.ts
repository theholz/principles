import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { loadProcessSpec } from "../../src/factory/loadSpec";
import { ArtifactRelationships, ProcessSpec } from "../../src/factory/types";
import {
  orphanArtifacts,
  danglingTraceability,
  rolesWithoutCtqs,
  unknownCtqCitations,
  undefinedDefects,
  malformedForgeArtifacts,
  danglingRelationships,
  malformedKnobs,
  validateProcessSpec,
} from "../../src/factory/validators";
import { Critique, failures } from "../../src/shared/types";

const seedPath = path.join(__dirname, "..", "..", "seeds", "factory-meta", "process-spec.json");
const seed: ProcessSpec = loadProcessSpec(fs.readFileSync(seedPath, "utf8"));

/** Deep-clone the seed and apply one mutation. */
const mutate = (fn: (spec: ProcessSpec) => void): ProcessSpec => {
  const clone = structuredClone(seed);
  fn(clone);
  return clone;
};

/** The mutation must fail EXACTLY the named criterion — every other verdict stays green. */
const expectOnlyFailure = (critique: Critique, criterionId: string) => {
  expect(failures(critique).map((v) => v.criterionId)).toEqual([criterionId]);
};

describe("validateProcessSpec", () => {
  it("passes the hand-authored seed spec on all criteria", () => {
    const crit = validateProcessSpec(seed);
    expect(failures(crit)).toEqual([]);
    expect(crit.verdicts.map((v) => v.criterionId)).toEqual([
      "pv-traceability",
      "pv-contract-complete",
      "pv-forge-relationships",
      "pv-knob-bounds",
    ]);
  });

  describe("pv-traceability", () => {
    it("fails an orphan artifact (cites no truth and no constraint), naming it", () => {
      const spec = mutate((s) => {
        s.artifacts[0].traceability.truthIds = [];
        s.artifacts[0].traceability.constraintIds = [];
      });
      const crit = validateProcessSpec(spec);
      expectOnlyFailure(crit, "pv-traceability");
      expect(failures(crit)[0].evidence).toContain("factory-intake");
    });

    it("fails a dangling truth citation", () => {
      const spec = mutate((s) => {
        s.artifacts[0].traceability.truthIds = ["t99"];
      });
      const crit = validateProcessSpec(spec);
      expectOnlyFailure(crit, "pv-traceability");
      expect(failures(crit)[0].evidence).toContain("factory-intake→t99");
    });

    it("fails a dangling constraint citation", () => {
      const spec = mutate((s) => {
        s.artifacts[1].traceability.constraintIds = ["c9"];
      });
      expectOnlyFailure(validateProcessSpec(spec), "pv-traceability");
    });

    it("accepts a citation of an assumption id (demoted truths still ground artifacts)", () => {
      const spec = mutate((s) => {
        s.foundations.assumptions.push({
          id: "a1",
          type: "assumption",
          statement: "operators review within a day",
          rationale: "demoted by the skeptic; proceed as if it holds",
        });
        s.artifacts[0].traceability.truthIds = ["a1"];
      });
      expect(failures(validateProcessSpec(spec))).toEqual([]);
    });
  });

  describe("pv-contract-complete", () => {
    it("fails a role with an empty ctqIds slice", () => {
      const spec = mutate((s) => {
        s.roles[0].ctqIds = [];
      });
      const crit = validateProcessSpec(spec);
      expectOnlyFailure(crit, "pv-contract-complete");
      expect(failures(crit)[0].evidence).toContain("agent-s1");
    });

    it("fails a role citing a CTQ id the contract does not define", () => {
      const spec = mutate((s) => {
        s.roles[0].ctqIds = ["ctq9"];
      });
      const crit = validateProcessSpec(spec);
      expectOnlyFailure(crit, "pv-contract-complete");
      expect(failures(crit)[0].evidence).toContain("agent-s1→ctq9");
    });

    it("fails an empty decision rule", () => {
      const spec = mutate((s) => {
        s.contract.decisionRule = "   ";
      });
      expectOnlyFailure(validateProcessSpec(spec), "pv-contract-complete");
    });

    it("fails a CTQ with an empty defect definition", () => {
      const spec = mutate((s) => {
        s.contract.ctqs[1].defectDefinition = "";
      });
      const crit = validateProcessSpec(spec);
      expectOnlyFailure(crit, "pv-contract-complete");
      expect(failures(crit)[0].evidence).toContain("ctq2");
    });
  });

  describe("pv-forge-relationships", () => {
    it("fails a forge_new artifact missing a relationship array", () => {
      const spec = mutate((s) => {
        s.artifacts[2].disposition = "forge_new";
        delete (s.artifacts[2].relationships as Partial<ArtifactRelationships>).composesWith;
      });
      const crit = validateProcessSpec(spec);
      expectOnlyFailure(crit, "pv-forge-relationships");
      expect(failures(crit)[0].evidence).toContain("deploy-discipline-hook");
    });

    it("fails a forge_new artifact with an empty name", () => {
      const spec = mutate((s) => {
        s.artifacts[2].disposition = "forge_new";
        s.artifacts[2].name = "  ";
      });
      const crit = validateProcessSpec(spec);
      expectOnlyFailure(crit, "pv-forge-relationships");
      expect(failures(crit)[0].evidence).toContain("(unnamed forge_new artifact)");
    });

    it("fails a dangling relationship name on a NON-forge artifact (check is spec-wide)", () => {
      const spec = mutate((s) => {
        s.artifacts[0].relationships.complements = ["phantom-gate"]; // disposition stays "generate"
      });
      const crit = validateProcessSpec(spec);
      expectOnlyFailure(crit, "pv-forge-relationships");
      expect(failures(crit)[0].evidence).toContain("factory-intake→phantom-gate");
    });

    it("does not treat bindsTools entries as artifact names", () => {
      const spec = mutate((s) => {
        s.artifacts[0].relationships.bindsTools = ["Bash", "WebFetch"];
      });
      expect(failures(validateProcessSpec(spec))).toEqual([]);
    });
  });

  describe("pv-knob-bounds", () => {
    it("fails a numeric default outside [min, max]", () => {
      const spec = mutate((s) => {
        s.knobs[0].default = 500; // seed range is {min: 10, max: 100}
      });
      const crit = validateProcessSpec(spec);
      expectOnlyFailure(crit, "pv-knob-bounds");
      expect(failures(crit)[0].evidence).toContain("scanMinSampleSize");
    });

    it("fails an inverted numeric range (min >= max)", () => {
      const spec = mutate((s) => {
        s.knobs[0].range = { min: 100, max: 10 };
        s.knobs[0].default = 50;
      });
      expectOnlyFailure(validateProcessSpec(spec), "pv-knob-bounds");
    });

    it("fails an enum default not in the allowed values", () => {
      const spec = mutate((s) => {
        s.knobs.push({
          name: "provider",
          purpose: "which gateway family runs the pack",
          range: ["claude", "grok"],
          default: "gpt",
        });
      });
      expectOnlyFailure(validateProcessSpec(spec), "pv-knob-bounds");
    });

    it("passes an enum knob whose default is one of the allowed values", () => {
      const spec = mutate((s) => {
        s.knobs.push({
          name: "provider",
          purpose: "which gateway family runs the pack",
          range: ["claude", "grok"],
          default: "grok",
        });
      });
      expect(failures(validateProcessSpec(spec))).toEqual([]);
    });
  });

  describe("pure offender functions", () => {
    it("orphanArtifacts / danglingTraceability find nothing in the seed", () => {
      expect(orphanArtifacts(seed.artifacts)).toEqual([]);
      expect(danglingTraceability(seed)).toEqual([]);
    });

    it("contract helpers find nothing in the seed", () => {
      expect(rolesWithoutCtqs(seed.roles)).toEqual([]);
      expect(unknownCtqCitations(seed.roles, seed.contract.ctqs)).toEqual([]);
      expect(undefinedDefects(seed.contract.ctqs)).toEqual([]);
    });

    it("relationship helpers find nothing in the seed", () => {
      expect(malformedForgeArtifacts(seed.artifacts)).toEqual([]);
      expect(danglingRelationships(seed.artifacts)).toEqual([]);
    });

    it("malformedKnobs finds nothing in the seed", () => {
      expect(malformedKnobs(seed.knobs)).toEqual([]);
    });
  });
});
