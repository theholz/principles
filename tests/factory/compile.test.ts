import { describe, it, expect } from "vitest";
import { compileProcess, enrichObjective, ENRICHMENT_MARKER } from "../../src/factory/compile";
import { loadProcessSpec } from "../../src/factory/loadSpec";
import { validateProcessSpec } from "../../src/factory/validators";
import { AssessFs } from "../../src/factory/assess";
import { Artifact } from "../../src/factory/types";
import { failures } from "../../src/shared/types";
import { Llm, LlmRequest } from "../../src/llm/gateway";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** In-memory fake fs over a flat file map (dirs are implicit from paths). */
function fixtureFs(files: Record<string, string>): AssessFs {
  const paths = Object.keys(files);
  return {
    exists: (p) => p in files || paths.some((f) => f.startsWith(`${p}/`)),
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    readdir: (p) => {
      const prefix = `${p}/`;
      const children = new Set<string>();
      for (const f of paths) {
        if (f.startsWith(prefix)) children.add(f.slice(prefix.length).split("/")[0]);
      }
      if (children.size === 0 && !(p in files)) throw new Error(`ENOENT: ${p}`);
      return [...children];
    },
  };
}

const FILES: Record<string, string> = {
  "/plugins/methodologies/.claude-plugin/plugin.json": "{}",
  "/plugins/methodologies/skills/dmaic/SKILL.md": "---\ndescription: Six Sigma DMAIC improvement loop\n---\nbody",
};

const PROBLEM = "keep a disciplined daily trade journal with review gates";

const INVENTORY = [
  { name: "dmaic", kind: "skill", location: "/plugins/methodologies/skills/dmaic", status: "partial" },
  { name: "journal-gate", kind: "hook", location: "", status: "gap" },
];

const CONSTRAINT_RESPONSE = {
  flowSteps: ["capture", "review", "act"],
  statement: "manual review capacity limits throughput",
  type: "knowledge",
  exploitOptions: ["batch reviews"],
  subordinateOptions: ["queue captures to review pace"],
  elevateOptions: ["automate first-pass review"],
  evidence: "review is the only step with no built capability in the inventory",
};

/** CTQ text mentions t1 so the role serving t1 gets a principled slice. */
const CONTRACT_RESPONSE = {
  ctqs: [
    {
      persona: "trader",
      metric: "entries citing their trigger (serves t1)",
      specLimit: "100%",
      defectDefinition: "an entry with no cited trigger",
    },
  ],
  baseline: "unmeasured",
  baselineJustification: "",
  decisionRule: "any defect in a weekly window trips review",
  controlPlan: { monitoringCadence: "weekly", response: "open improvement proposal" },
};

const GATE_ARTIFACT: Artifact = {
  name: "trigger-citation-gate",
  kind: "gate",
  disposition: "forge_new",
  traceability: { truthIds: ["t1"], constraintIds: ["c1"] },
  l2Rationale:
    "a gate, not a skill: citation must be non-bypassable at entry time; a skill relies on recall and a hook fires too late",
  relationships: { dependsOn: [], complements: [], composesWith: [], supersedes: [], bindsTools: ["git"] },
};

/** Criterion ids of whatever rubric the judge was handed, parsed from the
 * prompt — one fake serves the triage (a-*), decomposition (d-*), contract
 * (ct-*), and artifact-plan (ap-*) rubrics without hardcoding any of them. */
function rubricIds(prompt: string): string[] {
  const section = prompt.split("## Rubric")[1] ?? "";
  return [...section.matchAll(/^- ([\w-]+):/gm)].map((m) => m[1]);
}

const passAll = (prompt: string) => ({
  verdicts: rubricIds(prompt).map((id) => ({
    criterionId: id,
    pass: true,
    evidence: `criterion ${id} satisfied by cited candidate content`,
  })),
});

/**
 * ONE scripted fake covering the FULL compile schemaName surface end-to-end,
 * in the stateful-closure style: records every request, dispatches on
 * schemaName, and lets a test override single stages.
 */
function fullPipelineLlm(overrides: Partial<Record<string, (req: LlmRequest<unknown>) => unknown>> = {}) {
  const calls: LlmRequest<unknown>[] = [];
  const countBySchema = (name: string) => calls.filter((c) => c.schemaName === name).length;
  const schemaNames = () => calls.map((c) => c.schemaName);

  const llm = (async <T>(req: LlmRequest<T>) => {
    calls.push(req as LlmRequest<unknown>);
    const override = overrides[req.schemaName];
    if (override) return override(req as LlmRequest<unknown>);
    switch (req.schemaName) {
      // --- stage 1: ASSESS ---
      case "capability_inventory":
        return { inventory: INVENTORY };
      case "triage_verdict":
        return { verdict: "create_new", evidence: "dmaic is only partial; journal-gate is a gap — coverage below 50%" };
      case "constraint_analysis":
        return CONSTRAINT_RESPONSE;
      case "truth_attack": // constraint vetting AND truth vetting
        return { verdict: "survives", strongestAttack: "none", justification: "solid" };
      // --- stage 2: DECOMPOSE (existing core) ---
      case "landscape_survey":
        return {
          observations: [
            { kind: "genre-convention", statement: "trade journals include a review cadence", source: "practitioner literature" },
          ],
        };
      case "typed_truths":
        return {
          truths: [{ type: "constraint", statement: "every trade entry must cite its trigger", rationale: "r", groundedIn: [] }],
        };
      case "decomposition":
        return {
          subtasks: [
            { description: "capture and review each trade", servesTruths: ["t1"], dependsOnIndices: [], needsWeb: false, webJustification: "" },
          ],
          coverageMap: [{ dimension: "trade capture", handledBy: "1", exclusionReason: "" }],
        };
      case "frame_challenges":
        return { challenges: [] };
      // --- stage 3: CONTRACT ---
      case "process_contract":
        return CONTRACT_RESPONSE;
      // --- stage 4: SPEC ---
      case "agent_spec":
        return { name: "Journal keeper", instructions: "keep the journal, citing every trigger", outputHint: "journal entries" };
      case "artifact_plan":
        return { artifacts: [GATE_ARTIFACT] };
      // --- every judge ---
      case "rubric_verdicts":
        return passAll(req.prompt);
      default:
        throw new Error(`unexpected schema ${req.schemaName}`);
    }
  }) as unknown as Llm;

  return { llm, calls, countBySchema, schemaNames };
}

const baseOpts = () => ({ roots: ["/plugins"], webSurvey: true, fs: fixtureFs(FILES) });

// ---------------------------------------------------------------------------
// compileProcess
// ---------------------------------------------------------------------------

describe("compileProcess", () => {
  it("spec_ready happy path: spec round-trips the strict loader, passes validators, and is written via the injected writer", async () => {
    const { llm, calls } = fullPipelineLlm();
    const written: Record<string, string> = {};
    const result = await compileProcess(llm, PROBLEM, {
      ...baseOpts(),
      domain: "trading-discipline",
      scalingTier: "simple",
      outPath: "/out/process-spec.json",
      writeFile: (p, c) => {
        written[p] = c;
      },
    });

    expect(result.status).toBe("spec_ready");
    expect(result.escalations).toEqual([]);
    const spec = result.spec!;

    // Round-trip: what compile assembled is exactly what the disk loader accepts.
    expect(loadProcessSpec(JSON.stringify(spec))).toEqual(spec);
    expect(failures(validateProcessSpec(spec))).toEqual([]);

    // The written artifact is the same spec.
    expect(loadProcessSpec(written["/out/process-spec.json"])).toEqual(spec);

    // Assembly facts: meta from opts, principled CTQ slice, seed defaults.
    expect(spec.meta.domain).toBe("trading-discipline");
    expect(spec.meta.scalingTier).toBe("simple");
    expect(spec.meta.lineage).toEqual({ parentVersion: null, improvementProposals: [] });
    expect(spec.roles).toHaveLength(1);
    expect(spec.roles[0].ctqIds).toEqual(["ctq1"]);
    expect(spec.contract.governancePhase).toBe("shadow");
    expect(spec.artifacts).toEqual([GATE_ARTIFACT]);
    expect(spec.knobs[0].name).toBe("scanMinSampleSize");
    expect(spec.methodologyDeps).toEqual(["first-principles", "theory-of-constraints", "dmaic"]);
    expect(spec.foundations.survey).toHaveLength(1);
    expect(spec.foundations.truths.map((t) => t.id)).toEqual(["t1"]);

    // The HITL gate is in the report; compile never emitted a pack.
    expect(result.report.some((l) => l.includes("HITL"))).toBe(true);

    // Invariant 1: web tools only on the landscape survey, nowhere else.
    expect(calls.filter((c) => c.webTools === true).map((c) => c.schemaName)).toEqual(["landscape_survey"]);
  });

  it("build_nothing short-circuit on use_existing: zero downstream schema calls after triage", async () => {
    const { llm, schemaNames } = fullPipelineLlm({
      triage_verdict: () => ({ verdict: "use_existing", evidence: "dmaic covers >=80% of the need" }),
    });
    const written: string[] = [];
    const result = await compileProcess(llm, PROBLEM, {
      ...baseOpts(),
      outPath: "/out/spec.json",
      writeFile: (p) => {
        written.push(p);
      },
    });

    expect(result.status).toBe("build_nothing");
    expect(result.spec).toBeUndefined();
    expect(written).toEqual([]);

    // The requested-schemaName log shows nothing past stage 1.
    const downstream = [
      "landscape_survey",
      "typed_truths",
      "decomposition",
      "frame_challenges",
      "process_contract",
      "agent_spec",
      "artifact_plan",
    ];
    expect(schemaNames().filter((n) => downstream.includes(n))).toEqual([]);

    // The report carries the verdict evidence and the matched inventory.
    const report = result.report.join("\n");
    expect(report).toContain("dmaic covers >=80% of the need");
    expect(report).toContain("Matched inventory");
    expect(report).toContain("dmaic [skill, partial]");
  });

  it("build_nothing also fires on compose", async () => {
    const { llm, countBySchema } = fullPipelineLlm({
      triage_verdict: () => ({ verdict: "compose", evidence: "dmaic plus journal-gate combined cover the need" }),
    });
    const result = await compileProcess(llm, PROBLEM, baseOpts());
    expect(result.status).toBe("build_nothing");
    expect(countBySchema("typed_truths")).toBe(0);
  });

  it("prefixes the enriched objective — the marker, constraint, and inventory hits reach the typed_truths prompt", async () => {
    const { llm, calls, countBySchema } = fullPipelineLlm();
    const result = await compileProcess(llm, PROBLEM, { ...baseOpts(), webSurvey: false });

    const typedTruths = calls.find((c) => c.schemaName === "typed_truths")!;
    expect(typedTruths.prompt).toContain(ENRICHMENT_MARKER);
    expect(typedTruths.prompt).toContain("manual review capacity limits throughput");
    expect(typedTruths.prompt).toContain("dmaic [skill, partial]");
    expect(typedTruths.prompt).toContain(PROBLEM);

    // webSurvey false: the landscape survey is never requested, survey is empty.
    expect(countBySchema("landscape_survey")).toBe(0);
    expect(result.spec!.foundations.survey).toEqual([]);
    expect(result.status).toBe("spec_ready");
  });

  it("sorts existing capabilities before gaps in the enrichment prefix", () => {
    const enriched = enrichObjective(PROBLEM, {
      assessment: {
        triageVerdict: { verdict: "create_new", evidence: "e" },
        inventory: [
          { name: "gap-thing", kind: "skill", location: "", status: "gap" },
          { name: "built-thing", kind: "skill", location: "/x", status: "built" },
        ],
        constraint: { id: "c1", ...CONSTRAINT_RESPONSE, type: "knowledge" },
      },
      scannedRoots: [],
      unavailableRoots: [],
      notes: [],
    });
    expect(enriched.startsWith(ENRICHMENT_MARKER)).toBe(true);
    expect(enriched.indexOf("built-thing")).toBeLessThan(enriched.indexOf("gap-thing"));
    expect(enriched.indexOf(ENRICHMENT_MARKER)).toBeLessThan(enriched.indexOf(PROBLEM));
  });

  it("feeds an ap-lazy failure back into the second artifact_plan prompt and converges", async () => {
    const LAZY_ATTACK = "cheapest path past trigger-citation-gate is pasting a placeholder trigger — cosmetic compliance";
    let apJudgeCalls = 0;
    const { llm, calls, countBySchema } = fullPipelineLlm({
      rubric_verdicts: (req) => {
        const ids = rubricIds(req.prompt);
        if (ids.includes("ap-lazy")) {
          apJudgeCalls += 1;
          if (apJudgeCalls === 1) {
            return {
              verdicts: ids.map((id) => ({
                criterionId: id,
                pass: id !== "ap-lazy",
                evidence: id === "ap-lazy" ? LAZY_ATTACK : `criterion ${id} satisfied by cited candidate content`,
              })),
            };
          }
        }
        return passAll(req.prompt);
      },
    });

    const result = await compileProcess(llm, PROBLEM, { ...baseOpts(), webSurvey: false });

    expect(result.status).toBe("spec_ready");
    expect(result.escalations).toEqual([]); // converged on the second pass
    expect(countBySchema("artifact_plan")).toBe(2);
    const second = calls.filter((c) => c.schemaName === "artifact_plan")[1];
    expect(second.prompt).toContain(`ap-lazy: ${LAZY_ATTACK}`);
    expect(second.prompt).toContain("Previous artifact plan");
  });

  it("validation_failed: a plan citing an unknown truth id is caught by the validators, returned for inspection, never written", async () => {
    const { llm } = fullPipelineLlm({
      artifact_plan: () => ({
        artifacts: [{ ...GATE_ARTIFACT, traceability: { truthIds: ["t9"], constraintIds: [] } }],
      }),
    });
    const written: string[] = [];
    const result = await compileProcess(llm, PROBLEM, {
      ...baseOpts(),
      webSurvey: false,
      outPath: "/out/spec.json",
      writeFile: (p) => {
        written.push(p);
      },
    });

    expect(result.status).toBe("validation_failed");
    expect(written).toEqual([]); // NOT written to disk
    expect(result.spec).toBeDefined(); // still returned for inspection
    expect(result.spec!.artifacts[0].traceability.truthIds).toEqual(["t9"]);

    const report = result.report.join("\n");
    expect(report).toContain("pv-traceability");
    expect(report).toContain("t9");
    expect(report).toContain("NOT written");
  });

  it("collects escalations from decomposition, contract, and artifact planning — surfaced, never blessed", async () => {
    const STUCK = new Set(["d-minimal", "ct-baseline-honest", "ap-lazy"]);
    const { llm } = fullPipelineLlm({
      rubric_verdicts: (req) => ({
        verdicts: rubricIds(req.prompt).map((id) => ({
          criterionId: id,
          pass: !STUCK.has(id),
          evidence: STUCK.has(id)
            ? `criterion ${id} fails: concrete counterevidence cited from the candidate`
            : `criterion ${id} satisfied by cited candidate content`,
        })),
      }),
    });

    const result = await compileProcess(llm, PROBLEM, { ...baseOpts(), webSurvey: false });

    expect(result.escalations).toHaveLength(3);
    expect(result.escalations.some((e) => e.startsWith("foundations decomposition escalated") && e.includes("d-minimal"))).toBe(true);
    expect(result.escalations.some((e) => e.startsWith("contract escalated") && e.includes("ct-baseline-honest"))).toBe(true);
    expect(result.escalations.some((e) => e.startsWith("artifact planning escalated") && e.includes("ap-lazy"))).toBe(true);

    // Escalations are in the report too, and the run still completed with a spec.
    expect(result.report.filter((l) => l.startsWith("ESCALATION:"))).toHaveLength(3);
    expect(result.status).toBe("spec_ready"); // mechanically valid — but escalations are surfaced for the operator
    expect(result.spec).toBeDefined();
  });

  it("surfaces assembly notes (round-robin CTQ fallback) in the report", async () => {
    const { llm } = fullPipelineLlm({
      process_contract: () => ({
        ...CONTRACT_RESPONSE,
        ctqs: [{ ...CONTRACT_RESPONSE.ctqs[0], metric: "entries reviewed weekly" }], // no t1 mention
      }),
    });
    const result = await compileProcess(llm, PROBLEM, { ...baseOpts(), webSurvey: false });

    expect(result.status).toBe("spec_ready");
    expect(result.report.some((l) => l.startsWith("Assembly note:") && l.includes("round-robin"))).toBe(true);
    expect(result.spec!.roles[0].ctqIds).toEqual(["ctq1"]); // every role still carries a slice
  });

  it("carries assess degradation notes into the report", async () => {
    const { llm } = fullPipelineLlm();
    const result = await compileProcess(llm, PROBLEM, { ...baseOpts(), webSurvey: false, roots: ["/plugins", "/nope"] });

    expect(result.assessResult.unavailableRoots).toEqual(["/nope"]);
    expect(result.report.some((l) => l.startsWith("Assess note:") && l.includes("/nope"))).toBe(true);
    expect(result.status).toBe("spec_ready");
  });
});
