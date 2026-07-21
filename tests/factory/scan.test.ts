import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "path";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  OutcomeRecord,
  RegistryFile,
  readOutcomes,
  scanPack,
  scanPortfolio,
  checkRegistryDrift,
  ImprovementProposalSchema,
} from "../../src/factory/scan";
import { loadProcessSpec } from "../../src/factory/loadSpec";
import { ProcessSpec } from "../../src/factory/types";
import { Llm, LlmRequest } from "../../src/llm/gateway";

// ---------------------------------------------------------------------------
// Fixtures — the real seed spec + synthetic outcome dumps
// ---------------------------------------------------------------------------

const seedPath = path.join(__dirname, "..", "..", "seeds", "factory-meta", "process-spec.json");
const seedJson = fs.readFileSync(seedPath, "utf8");

/** Fresh, fully-validated copy of the real seed spec per test. */
const seed = (): ProcessSpec => loadProcessSpec(seedJson);

/** The seed with a different pack name (a second portfolio member). */
const seedNamed = (name: string): ProcessSpec => {
  const s = seed();
  return { ...s, meta: { ...s.meta, name } };
};

const record = (over: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  packName: "process-factory-meta",
  packVersion: "0.1.0",
  ctqId: "ctq1",
  window: "2026-W29",
  defect: false,
  evidence: "scan window clean",
  recordedAt: "2026-07-20T00:00:00Z",
  ...over,
});

/** n records with distinct windows so synthetic dumps look like real ones. */
const records = (n: number, over: Partial<OutcomeRecord> = {}): OutcomeRecord[] =>
  Array.from({ length: n }, (_, i) => record({ window: `2026-W${i + 1}`, ...over }));

/** An Llm that fails the test if any call reaches it (zero-LLM assertions). */
const forbiddenLlm: Llm = (async () => {
  throw new Error("LLM must not be called on a deterministic pre-check path");
}) as unknown as Llm;

const PROPOSAL = {
  summary: "Lower scanMinSampleSize default: ctq1 defects recur across consecutive windows",
  specDiff: [
    {
      path: "knobs.0.default",
      from: "20",
      to: "10",
      rationale: "records r1 and r2 show ctq1 defects in consecutive windows 2026-W1 and 2026-W2",
    },
  ],
  evidence: ["r1: ctq1 defect in window 2026-W1", "r2: ctq1 defect in window 2026-W2"],
};

const passBoth = {
  verdicts: [
    { criterionId: "ip-evidence", pass: true, evidence: "rationale cites r1 and r2 by label" },
    { criterionId: "ip-scope", pass: true, evidence: "only knobs.0.default is touched" },
  ],
};

/**
 * Scripted fake in the tests/factory/assess.test.ts style: dispatches on
 * schemaName, records every request, and lets a test override single stages.
 */
function scriptedLlm(overrides: Partial<Record<string, (req: LlmRequest<unknown>) => unknown>> = {}) {
  const calls: LlmRequest<unknown>[] = [];
  const countBySchema = (name: string) => calls.filter((c) => c.schemaName === name).length;

  const llm = (async <T>(req: LlmRequest<T>) => {
    calls.push(req as LlmRequest<unknown>);
    const override = overrides[req.schemaName];
    if (override) return override(req as LlmRequest<unknown>);
    switch (req.schemaName) {
      case "improvement_proposal":
        return PROPOSAL;
      case "rubric_verdicts":
        return passBoth;
      default:
        throw new Error(`unexpected schema ${req.schemaName}`);
    }
  }) as unknown as Llm;

  return { llm, calls, countBySchema };
}

// ---------------------------------------------------------------------------
// readOutcomes
// ---------------------------------------------------------------------------

describe("readOutcomes", () => {
  it("parses a valid dump into typed records", () => {
    const dump = [record(), record({ defect: true, evidence: "pack emitted without approval" })];
    expect(readOutcomes(JSON.stringify(dump))).toEqual(dump);
  });

  it("rejects invalid JSON with a parse error, not a shape error", () => {
    expect(() => readOutcomes("{nope")).toThrow(/not valid JSON/);
  });

  it("rejects a non-array root and lists the offending path", () => {
    expect(() => readOutcomes(JSON.stringify({ records: [] }))).toThrow(/shape validation failed/);
  });

  it("lists every offending path — missing field, wrong type, unknown key", () => {
    const bad = [
      { ...record(), defect: "yes" }, // wrong type
      (({ evidence: _evidence, ...rest }) => rest)(record()), // missing field
      { ...record(), extra: true }, // unknown key (strict)
    ];
    const err = (() => {
      try {
        readOutcomes(JSON.stringify(bad));
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toContain("0.defect");
    expect(err).toContain("1.evidence");
    expect(err).toContain("2");
  });
});

// ---------------------------------------------------------------------------
// scanPack — deterministic pre-checks (zero LLM calls)
// ---------------------------------------------------------------------------

describe("scanPack pre-checks", () => {
  it("returns insufficient_data with ZERO LLM calls below the minimum sample", async () => {
    const proposal = await scanPack(forbiddenLlm, seed(), records(5, { defect: true }));
    expect(proposal.verdict).toBe("insufficient_data");
    expect(proposal.packName).toBe("process-factory-meta");
    expect(proposal.targetSpecVersion).toBe("0.1.0");
    expect(proposal.specDiff).toEqual([]);
    expect(proposal.summary).toContain("5");
    expect(proposal.summary).toContain("20"); // the seed's scanMinSampleSize knob default
    expect(proposal.evidence.some((e) => e.includes("minimum-sample rule"))).toBe(true);
  });

  it("counts only records for this pack toward the sample", async () => {
    const outcomes = [...records(25, { packName: "some-other-pack" }), ...records(3)];
    const proposal = await scanPack(forbiddenLlm, seed(), outcomes);
    expect(proposal.verdict).toBe("insufficient_data");
    expect(proposal.summary).toContain("3");
  });

  it("takes the sample floor from the spec's scanMinSampleSize knob default", async () => {
    const spec = seed();
    spec.knobs = [{ ...spec.knobs[0], default: 5 }];
    // 6 clean records: below the hardcoded fallback of 20, above the knob's 5.
    const healthy = await scanPack(forbiddenLlm, spec, records(6));
    expect(healthy.verdict).toBe("healthy");
    const insufficient = await scanPack(forbiddenLlm, spec, records(4));
    expect(insufficient.verdict).toBe("insufficient_data");
    expect(insufficient.summary).toContain("5");
  });

  it("lets opts.minSample override the knob default", async () => {
    // 4 clean records with the seed's knob at 20: only the override lets this pass.
    const proposal = await scanPack(forbiddenLlm, seed(), records(4), { minSample: 3 });
    expect(proposal.verdict).toBe("healthy");
  });

  it("returns healthy with ZERO LLM calls when no record is a defect", async () => {
    const proposal = await scanPack(forbiddenLlm, seed(), records(20));
    expect(proposal.verdict).toBe("healthy");
    expect(proposal.specDiff).toEqual([]);
    expect(proposal.summary).toContain("0 defects");
    expect(proposal.summary).toContain("20");
    // The decision rule the (un-triggered) verdict was measured against is cited.
    expect(proposal.evidence.some((e) => e.includes(seed().contract.decisionRule))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scanPack — judged propose path
// ---------------------------------------------------------------------------

/** 20 relevant records, 2 of them ctq1 defects: sample met, rule triggered. */
const defectiveOutcomes = (): OutcomeRecord[] => [
  ...records(18),
  record({ defect: true, window: "2026-W1", evidence: "pack emitted without recorded approval" }),
  record({ defect: true, window: "2026-W2", evidence: "pack emitted without recorded approval" }),
];

describe("scanPack propose path", () => {
  it("proposes a judged spec diff and never requests web tools", async () => {
    const { llm, calls, countBySchema } = scriptedLlm();
    const proposal = await scanPack(llm, seed(), defectiveOutcomes());

    expect(proposal.verdict).toBe("propose");
    expect(proposal.summary).toBe(PROPOSAL.summary);
    expect(proposal.specDiff).toEqual(PROPOSAL.specDiff);
    expect(proposal.evidence).toEqual(PROPOSAL.evidence); // converged: no escalation appended
    expect(countBySchema("improvement_proposal")).toBe(1);
    expect(countBySchema("rubric_verdicts")).toBe(1);
    // Invariant 1: the scan stage never requests web tools.
    expect(calls.every((c) => c.webTools === undefined)).toBe(true);
    // The elicitation grounds the model in the labeled defect records.
    const elicit = calls.find((c) => c.schemaName === "improvement_proposal")!;
    expect(elicit.prompt).toContain("[r1]");
    expect(elicit.prompt).toContain("pack emitted without recorded approval");
    expect(elicit.prompt).toContain(seed().contract.decisionRule);
  });

  it("feeds the critique back and refines when the judge fails ip-evidence", async () => {
    let judgeCall = 0;
    const { llm, calls, countBySchema } = scriptedLlm({
      rubric_verdicts: () => {
        judgeCall += 1;
        if (judgeCall === 1) {
          return {
            verdicts: [
              { criterionId: "ip-evidence", pass: false, evidence: "rationale never names a record label" },
              { criterionId: "ip-scope", pass: true, evidence: "only knobs touched" },
            ],
          };
        }
        return passBoth;
      },
    });
    const proposal = await scanPack(llm, seed(), defectiveOutcomes());

    expect(countBySchema("improvement_proposal")).toBe(2);
    const second = calls.filter((c) => c.schemaName === "improvement_proposal")[1];
    // Invariant 5: the critique is fed back into the revision prompt.
    expect(second.prompt).toContain("rationale never names a record label");
    expect(second.prompt).toContain("Previous proposal");
    expect(proposal.verdict).toBe("propose");
    expect(proposal.evidence.some((e) => e.includes("ESCALATION"))).toBe(false);
  });

  it("judges an ip-scope violation (diff into foundations.truths) and accepts the refined diff", async () => {
    let elicitCall = 0;
    let judgeCall = 0;
    const { llm, calls, countBySchema } = scriptedLlm({
      improvement_proposal: () => {
        elicitCall += 1;
        if (elicitCall === 1) {
          return {
            summary: "Rewrite the approval truth",
            specDiff: [
              {
                path: "foundations.truths.0.statement",
                from: "A process spec must be operator-approved before emission.",
                to: "Specs may be emitted without approval.",
                rationale: "records r1 and r2 show approval defects",
              },
            ],
            evidence: ["r1", "r2"],
          };
        }
        return PROPOSAL;
      },
      rubric_verdicts: () => {
        judgeCall += 1;
        if (judgeCall === 1) {
          return {
            verdicts: [
              { criterionId: "ip-evidence", pass: true, evidence: "cites r1 and r2" },
              {
                criterionId: "ip-scope",
                pass: false,
                evidence: "foundations.truths.0.statement is structural — re-compilation territory",
              },
            ],
          };
        }
        return passBoth;
      },
    });
    const proposal = await scanPack(llm, seed(), defectiveOutcomes());

    // The out-of-scope diff reached the judge verbatim...
    const firstJudge = calls.filter((c) => c.schemaName === "rubric_verdicts")[0];
    expect(firstJudge.prompt).toContain("foundations.truths.0.statement");
    // ...was failed, fed back, and the refined in-scope diff converged.
    expect(countBySchema("improvement_proposal")).toBe(2);
    const second = calls.filter((c) => c.schemaName === "improvement_proposal")[1];
    expect(second.prompt).toContain("re-compilation territory");
    expect(proposal.verdict).toBe("propose");
    expect(proposal.specDiff).toEqual(PROPOSAL.specDiff);
    expect(proposal.specDiff.every((d) => !d.path.startsWith("foundations"))).toBe(true);
  });

  it("surfaces persistent judge failure as an ESCALATION in evidence — never silently blessed", async () => {
    const { llm, countBySchema } = scriptedLlm({
      rubric_verdicts: () => ({
        verdicts: [
          { criterionId: "ip-evidence", pass: false, evidence: "still cites no specific record" },
          { criterionId: "ip-scope", pass: true, evidence: "scope fine" },
        ],
      }),
    });
    const proposal = await scanPack(llm, seed(), defectiveOutcomes());

    // refine maxIterations 2: elicit -> fail -> elicit -> same failure -> escalated.
    expect(countBySchema("improvement_proposal")).toBe(2);
    expect(proposal.verdict).toBe("propose");
    const escalation = proposal.evidence.find((e) => e.includes("ESCALATION"));
    expect(escalation).toBeDefined();
    expect(escalation).toContain("ip-evidence");
    expect(escalation).toContain("still cites no specific record");
    // The model's own evidence entries are preserved alongside the escalation.
    expect(proposal.evidence).toContain(PROPOSAL.evidence[0]);
  });
});

// ---------------------------------------------------------------------------
// scanPortfolio — per-pack scans + deterministic Pareto pass
// ---------------------------------------------------------------------------

describe("scanPortfolio", () => {
  // Combined dump shared by both entries: relevance filtering must dedupe it.
  const combinedDump = (): OutcomeRecord[] => [
    ...records(3, { defect: true, ctqId: "ctq1" }), // 3 ctq1 defects, meta pack
    ...records(2, { packName: "pack-b", defect: true, ctqId: "ctq1" }), // 2 ctq1 defects, pack-b
    record({ packName: "pack-b", defect: true, ctqId: "ctq2", window: "2026-W9" }), // 1 ctq2 defect
  ];

  it("scans each pack and fires the Pareto note when one ctqId is >50% of defects across >=2 packs", async () => {
    // Small per-pack samples → both scans are insufficient_data with zero LLM
    // calls, while the Pareto pass still counts every defect deterministically.
    const { perPack, portfolioNotes } = await scanPortfolio(forbiddenLlm, [
      { spec: seed(), outcomes: combinedDump() },
      { spec: seedNamed("pack-b"), outcomes: combinedDump() },
    ]);

    expect(perPack.map((p) => p.verdict)).toEqual(["insufficient_data", "insufficient_data"]);
    expect(perPack.map((p) => p.packName)).toEqual(["process-factory-meta", "pack-b"]);
    expect(portfolioNotes).toHaveLength(1);
    // 5 of 6 defects are ctq1, spanning both packs → factory-template candidate.
    expect(portfolioNotes[0]).toContain('"ctq1"');
    expect(portfolioNotes[0]).toContain("5 of 6");
    expect(portfolioNotes[0]).toContain("process-factory-meta");
    expect(portfolioNotes[0]).toContain("pack-b");
    expect(portfolioNotes[0]).toContain("factory-template");
  });

  it("stays silent when the dominant ctqId sits in a single pack", async () => {
    const { portfolioNotes } = await scanPortfolio(forbiddenLlm, [
      { spec: seed(), outcomes: records(5, { defect: true, ctqId: "ctq1" }) },
      { spec: seedNamed("pack-b"), outcomes: [record({ packName: "pack-b", defect: true, ctqId: "ctq2" })] },
    ]);
    // ctq1 is 5 of 6 defects but appears in one pack only; ctq2 is 1 of 6.
    expect(portfolioNotes).toEqual([]);
  });

  it("stays silent at exactly 50% — the condition is strictly greater", async () => {
    const { portfolioNotes } = await scanPortfolio(forbiddenLlm, [
      {
        spec: seed(),
        outcomes: [
          ...records(2, { defect: true, ctqId: "ctq1" }),
          record({ defect: true, ctqId: "ctq2", window: "2026-W8" }),
        ],
      },
      {
        spec: seedNamed("pack-b"),
        outcomes: [
          ...records(2, { packName: "pack-b", defect: true, ctqId: "ctq1" }).map((r, i) => ({
            ...r,
            window: `2026-W${20 + i}`,
          })),
          ...records(3, { packName: "pack-b", defect: true, ctqId: "ctq3" }),
        ],
      },
    ]);
    // 8 defects total: ctq1 has 4 (exactly 50%, across 2 packs) — no note.
    expect(portfolioNotes).toEqual([]);
  });

  it("reports no notes for a defect-free portfolio", async () => {
    const { perPack, portfolioNotes } = await scanPortfolio(forbiddenLlm, [
      { spec: seed(), outcomes: records(20) },
    ]);
    expect(perPack[0].verdict).toBe("healthy");
    expect(portfolioNotes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkRegistryDrift
// ---------------------------------------------------------------------------

describe("checkRegistryDrift", () => {
  const registry: RegistryFile = {
    entries: [
      { name: "process-factory-meta", version: "0.1.0", specVersion: "0.1.0", metricsLocation: "engram://metrics/meta" },
      { name: "intake", version: "0.2.0", specVersion: "0.1.1", metricsLocation: "engram://metrics/intake" },
    ],
  };

  it("returns no notes when registry and marketplace agree", () => {
    expect(checkRegistryDrift(registry, ["process-factory-meta@0.1.0", "intake@0.2.0"])).toEqual([]);
  });

  it("flags registry entries missing from the marketplace listing", () => {
    const notes = checkRegistryDrift(registry, ["process-factory-meta@0.1.0"]);
    expect(notes).toEqual([
      "registry drift: intake@0.2.0 is in the registry but not in the marketplace listing",
    ]);
  });

  it("flags marketplace packs missing from the registry — including version mismatches", () => {
    const notes = checkRegistryDrift(registry, [
      "process-factory-meta@0.1.0",
      "intake@0.3.0", // marketplace moved ahead of the registry
      "rogue-pack@1.0.0", // never registered
    ]);
    expect(notes).toEqual([
      "registry drift: intake@0.2.0 is in the registry but not in the marketplace listing",
      "registry drift: intake@0.3.0 is in the marketplace listing but not in the registry",
      "registry drift: rogue-pack@1.0.0 is in the marketplace listing but not in the registry",
    ]);
  });

  it("flags every registry entry against an empty marketplace and vice versa", () => {
    expect(checkRegistryDrift(registry, [])).toHaveLength(2);
    expect(checkRegistryDrift({ entries: [] }, ["a@1.0.0"])).toEqual([
      "registry drift: a@1.0.0 is in the marketplace listing but not in the registry",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Schema safety (the Task 8 slice for the IMPROVE schema)
// ---------------------------------------------------------------------------

describe("improvement_proposal schema is structured-output-safe", () => {
  const walk = (node: unknown, visit: (obj: Record<string, unknown>) => void): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, visit);
      return;
    }
    if (node && typeof node === "object") {
      visit(node as Record<string, unknown>);
      for (const value of Object.values(node)) walk(value, visit);
    }
  };

  it("no $schema after gateway stripping, closed objects, no numeric/string constraints", () => {
    // Mirror both gateways: target "openAi", then delete the root $schema key.
    const jsonSchema = zodToJsonSchema(ImprovementProposalSchema as never, { target: "openAi" }) as Record<
      string,
      unknown
    >;
    delete jsonSchema["$schema"];

    const forbiddenKeys = [
      "$schema",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "pattern",
      "$ref",
    ];
    walk(jsonSchema, (obj) => {
      for (const key of forbiddenKeys) {
        expect(obj, `forbidden key "${key}" found`).not.toHaveProperty(key);
      }
      if (obj.type === "object") {
        expect(obj.additionalProperties, "object schema must be closed").toBe(false);
      }
    });
  });
});
