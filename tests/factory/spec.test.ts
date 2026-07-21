import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  planArtifacts,
  assembleProcessSpec,
  assembleAndValidateSpec,
  mapRoleCtqs,
  renderArtifactPlanForJudging,
  ArtifactPlanSchema,
  ARTIFACT_PLAN_RUBRIC,
  DEFAULT_KNOBS,
  DEFAULT_METHODOLOGY_DEPS,
  SpecAssemblyInputs,
} from "../../src/factory/spec";
import { AssessResult } from "../../src/factory/assess";
import { ContractResult } from "../../src/factory/contract";
import { Artifact, ConstraintAnalysis, Ctq, InventoryEntry } from "../../src/factory/types";
import { loadProcessSpec } from "../../src/factory/loadSpec";
import { Foundations } from "../../src/core/foundations";
import { AgentSpec, Subtask, Truth, failures } from "../../src/shared/types";
import { Llm, LlmRequest } from "../../src/llm/gateway";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRUTHS: Truth[] = [
  { id: "t1", type: "constraint", statement: "every trade entry must cite its trigger", rationale: "r", groundedIn: [] },
  { id: "t2", type: "assumption", statement: "the operator reviews weekly", rationale: "r" },
];

const CONSTRAINT: ConstraintAnalysis = {
  id: "c1",
  flowSteps: ["capture", "review", "act"],
  statement: "manual review capacity limits throughput",
  type: "knowledge",
  exploitOptions: ["batch reviews"],
  subordinateOptions: ["queue captures"],
  elevateOptions: ["automate first pass"],
  evidence: "review is the only step with no built capability",
};

const SUBTASKS: Subtask[] = [
  { id: "s1", description: "capture and review each trade", servesTruths: ["t1"], dependsOn: [] },
];

const INVENTORY: InventoryEntry[] = [
  { name: "dmaic", kind: "skill", location: "/plugins/methodologies/skills/dmaic", status: "partial" },
  { name: "journal-gate", kind: "hook", location: "", status: "gap" },
];

const GATE_ARTIFACT: Artifact = {
  name: "trigger-citation-gate",
  kind: "gate",
  disposition: "forge_new",
  traceability: { truthIds: ["t1"], constraintIds: ["c1"] },
  l2Rationale:
    "a gate, not a skill: citation must be non-bypassable at entry time; a skill relies on recall and a hook fires too late",
  relationships: { dependsOn: [], complements: [], composesWith: [], supersedes: [], bindsTools: ["git"] },
};

const passVerdicts = () => ({
  verdicts: ARTIFACT_PLAN_RUBRIC.map((c) => ({
    criterionId: c.id,
    pass: true,
    evidence: `criterion ${c.id} satisfied by cited plan content`,
  })),
});

/** Scripted fake in the stateful-closure style: dispatches on schemaName,
 * records every request, and lets a test override single stages. */
function scriptedLlm(overrides: Partial<Record<string, (req: LlmRequest<unknown>) => unknown>> = {}) {
  const calls: LlmRequest<unknown>[] = [];
  const countBySchema = (name: string) => calls.filter((c) => c.schemaName === name).length;

  const llm = (async <T>(req: LlmRequest<T>) => {
    calls.push(req as LlmRequest<unknown>);
    const override = overrides[req.schemaName];
    if (override) return override(req as LlmRequest<unknown>);
    switch (req.schemaName) {
      case "artifact_plan":
        return { artifacts: [GATE_ARTIFACT] };
      case "rubric_verdicts":
        return passVerdicts();
      default:
        throw new Error(`unexpected schema ${req.schemaName}`);
    }
  }) as unknown as Llm;

  return { llm, calls, countBySchema };
}

const OBJECTIVE = "keep a disciplined daily trade journal with review gates";

// ---------------------------------------------------------------------------
// planArtifacts
// ---------------------------------------------------------------------------

describe("planArtifacts", () => {
  it("elicits one judged plan on the happy path, grounded in truths, constraint, subtasks, and inventory — never web", async () => {
    const { llm, calls, countBySchema } = scriptedLlm();
    const { artifacts, outcome } = await planArtifacts(llm, OBJECTIVE, TRUTHS, CONSTRAINT, SUBTASKS, INVENTORY);

    expect(outcome.status).toBe("converged");
    expect(outcome.iterations).toBe(1);
    expect(artifacts).toEqual([GATE_ARTIFACT]);
    expect(countBySchema("artifact_plan")).toBe(1);

    const elicit = calls.find((c) => c.schemaName === "artifact_plan")!;
    expect(elicit.prompt).toContain("t1 [constraint]: every trade entry must cite its trigger");
    expect(elicit.prompt).toContain("c1 [knowledge]: manual review capacity limits throughput");
    expect(elicit.prompt).toContain("s1: capture and review each trade");
    expect(elicit.prompt).toContain("dmaic [skill, partial]");

    // The judge sees the rendered plan AND the inventory (ap-reuse needs it).
    const judgeReq = calls.find((c) => c.schemaName === "rubric_verdicts")!;
    expect(judgeReq.prompt).toContain("trigger-citation-gate [gate, forge_new]");
    expect(judgeReq.prompt).toContain("dmaic [skill, partial]");
    expect(judgeReq.prompt).toContain("ap-lazy");

    // Invariant 1: this stage never requests web tools.
    expect(calls.every((c) => c.webTools === undefined)).toBe(true);
  });

  it("feeds an ap-reuse failure back as a revision (previous plan + critique) and converges", async () => {
    const REUSE_ATTACK = 'reuse_existing artifact "phantom-skill" names nothing in the inventory (closest: dmaic)';
    let judgeCalls = 0;
    const { llm, calls, countBySchema } = scriptedLlm({
      artifact_plan: () =>
        countBySchema("artifact_plan") === 1
          ? { artifacts: [{ ...GATE_ARTIFACT, name: "phantom-skill", kind: "skill", disposition: "reuse_existing" }] }
          : { artifacts: [GATE_ARTIFACT] },
      rubric_verdicts: () => {
        judgeCalls += 1;
        if (judgeCalls === 1) {
          return {
            verdicts: ARTIFACT_PLAN_RUBRIC.map((c) => ({
              criterionId: c.id,
              pass: c.id !== "ap-reuse",
              evidence: c.id === "ap-reuse" ? REUSE_ATTACK : `criterion ${c.id} satisfied by cited plan content`,
            })),
          };
        }
        return passVerdicts();
      },
    });

    const { outcome } = await planArtifacts(llm, OBJECTIVE, TRUTHS, CONSTRAINT, SUBTASKS, INVENTORY);

    expect(outcome.status).toBe("converged");
    expect(outcome.iterations).toBe(2);
    const second = calls.filter((c) => c.schemaName === "artifact_plan")[1];
    expect(second.prompt).toContain("Previous artifact plan");
    expect(second.prompt).toContain("phantom-skill");
    expect(second.prompt).toContain(`ap-reuse: ${REUSE_ATTACK}`);
    // What passed is preserved, not re-litigated:
    expect(second.prompt).toContain("ap-lazy: criterion ap-lazy satisfied by cited plan content");
  });

  it("escalates when the lazy-agent test fails twice — surfaced in the outcome, never blessed", async () => {
    const { llm, countBySchema } = scriptedLlm({
      rubric_verdicts: () => ({
        verdicts: ARTIFACT_PLAN_RUBRIC.map((c) => ({
          criterionId: c.id,
          pass: c.id !== "ap-lazy",
          evidence:
            c.id === "ap-lazy"
              ? "cheapest path past trigger-citation-gate is pasting a placeholder trigger — cosmetic compliance"
              : `criterion ${c.id} satisfied by cited plan content`,
        })),
      }),
    });

    const { artifacts, outcome } = await planArtifacts(llm, OBJECTIVE, TRUTHS, CONSTRAINT, SUBTASKS, INVENTORY);

    expect(outcome.status).toBe("escalated");
    if (outcome.status === "escalated") expect(outcome.stuckOn).toEqual(["ap-lazy"]);
    expect(countBySchema("artifact_plan")).toBe(2); // no third re-roll
    expect(artifacts).toEqual([GATE_ARTIFACT]); // last candidate returned AS unconverged
  });
});

describe("renderArtifactPlanForJudging", () => {
  it("renders every judged surface: kind, disposition, traceability, rationale, relationships", () => {
    const rendered = renderArtifactPlanForJudging([GATE_ARTIFACT]);
    expect(rendered).toContain("trigger-citation-gate [gate, forge_new]");
    expect(rendered).toContain("truths=[t1] constraints=[c1]");
    expect(rendered).toContain("l2Rationale: a gate, not a skill");
    expect(rendered).toContain("bindsTools=[git]");
    expect(renderArtifactPlanForJudging([])).toBe("(empty artifact plan)");
  });
});

// ---------------------------------------------------------------------------
// Assembly fixtures
// ---------------------------------------------------------------------------

const REJECTED: { truth: Truth; attack: string } = {
  truth: { id: "t3", type: "fact", statement: "traders always journal", rationale: "r", groundedIn: [] },
  attack: "counterexample: most retail traders keep no journal at all",
};

const foundationsFixture = (): Foundations => ({
  survey: [{ id: "obs1", kind: "topic-axis", statement: "journals span capture and review", source: "practitioner literature" }],
  truths: [TRUTHS[0], TRUTHS[1]],
  vet: { kept: [TRUTHS[0]], assumptions: [TRUTHS[1]], rejected: [REJECTED] },
  subtasks: SUBTASKS,
  coverageMap: [{ dimension: "trade capture", handledBy: "s1", exclusionReason: "" }],
  decomposition: {
    status: "converged",
    result: { subtasks: SUBTASKS, coverageMap: [{ dimension: "trade capture", handledBy: "s1", exclusionReason: "" }] },
    iterations: 1,
    history: [],
  },
});

const assessResultFixture = (): AssessResult => ({
  assessment: {
    triageVerdict: { verdict: "create_new", evidence: "dmaic is only partial; journal-gate is a gap" },
    inventory: INVENTORY,
    constraint: CONSTRAINT,
  },
  scannedRoots: ["/plugins"],
  unavailableRoots: [],
  notes: [],
});

const ctqLinkedToT1: Ctq = {
  id: "ctq1",
  persona: "trader",
  metric: "entries citing their trigger (serves t1)",
  specLimit: "100%",
  defectDefinition: "an entry with no cited trigger",
};

const contractResultFixture = (ctqs: Ctq[] = [ctqLinkedToT1]): ContractResult => {
  const contract = {
    ctqs,
    baseline: "unmeasured",
    decisionRule: "any defect in a weekly window trips review",
    controlPlan: { monitoringCadence: "weekly", response: "open improvement proposal" },
    governancePhase: "shadow" as const,
  };
  return {
    contract,
    outcome: { status: "converged", result: { ...contract, baselineJustification: "" }, iterations: 1, history: [] },
  };
};

const ROLES: AgentSpec[] = [
  {
    id: "agent-s1",
    name: "Journal keeper",
    subtaskId: "s1",
    instructions: "keep the journal",
    servesTruths: ["t1"],
    dependsOn: [],
    outputHint: "journal entries",
  },
];

const assemblyInputs = (over: Partial<SpecAssemblyInputs> = {}): SpecAssemblyInputs => ({
  meta: {
    name: "trade-journal",
    version: "0.1.0",
    problemStatement: OBJECTIVE,
    domain: "trading-discipline",
    scalingTier: "simple",
  },
  assessResult: assessResultFixture(),
  foundations: foundationsFixture(),
  contractResult: contractResultFixture(),
  roles: ROLES,
  artifacts: [GATE_ARTIFACT],
  ...over,
});

// ---------------------------------------------------------------------------
// mapRoleCtqs
// ---------------------------------------------------------------------------

describe("mapRoleCtqs", () => {
  it("links a role to the CTQs whose text mentions a truth id the role serves", () => {
    const { ctqIdsByRole, notes } = mapRoleCtqs(ROLES, [ctqLinkedToT1]);
    expect(ctqIdsByRole["agent-s1"]).toEqual(["ctq1"]);
    expect(notes).toEqual([]);
  });

  it("does not match a truth id embedded inside a longer token (t1 vs t11)", () => {
    const ctq: Ctq = { ...ctqLinkedToT1, metric: "entries per week (serves t11)" };
    const { ctqIdsByRole, notes } = mapRoleCtqs(ROLES, [ctq]);
    // No principled link — round-robin fallback fires and is noted.
    expect(ctqIdsByRole["agent-s1"]).toEqual(["ctq1"]);
    expect(notes.some((n) => n.includes("round-robin") && n.includes("agent-s1"))).toBe(true);
  });

  it("distributes round-robin so every role gets at least one CTQ, and says so", () => {
    const roles: AgentSpec[] = [
      { ...ROLES[0], id: "agent-s1", servesTruths: [] },
      { ...ROLES[0], id: "agent-s2", subtaskId: "s2", servesTruths: [] },
      { ...ROLES[0], id: "agent-s3", subtaskId: "s3", servesTruths: [] },
    ];
    const ctqs: Ctq[] = [
      { ...ctqLinkedToT1, id: "ctq1", metric: "m1" },
      { ...ctqLinkedToT1, id: "ctq2", metric: "m2" },
    ];
    const { ctqIdsByRole, notes } = mapRoleCtqs(roles, ctqs);
    expect(ctqIdsByRole).toEqual({ "agent-s1": ["ctq1"], "agent-s2": ["ctq2"], "agent-s3": ["ctq1"] });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("agent-s1, agent-s2, agent-s3");
  });

  it("notes an empty-CTQ contract instead of inventing slices", () => {
    const { ctqIdsByRole, notes } = mapRoleCtqs(ROLES, []);
    expect(ctqIdsByRole["agent-s1"]).toEqual([]);
    expect(notes.some((n) => n.includes("no CTQs") && n.includes("pv-contract-complete"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assembleProcessSpec
// ---------------------------------------------------------------------------

describe("assembleProcessSpec", () => {
  it("assembles every stage output into the ProcessSpec shape with seed-pattern defaults", () => {
    const spec = assembleProcessSpec(assemblyInputs());

    // meta: lineage defaults to a parentless v0.
    expect(spec.meta).toEqual({
      name: "trade-journal",
      version: "0.1.0",
      problemStatement: OBJECTIVE,
      domain: "trading-discipline",
      scalingTier: "simple",
      lineage: { parentVersion: null, improvementProposals: [] },
    });

    // assessment passes through unchanged.
    expect(spec.assessment).toEqual(assessResultFixture().assessment);

    // foundations map from the vet split, not the merged truths list.
    expect(spec.foundations.truths).toEqual([TRUTHS[0]]);
    expect(spec.foundations.assumptions).toEqual([TRUTHS[1]]);
    expect(spec.foundations.rejected).toEqual([REJECTED]);
    expect(spec.foundations.subtasks).toEqual(SUBTASKS);
    expect(spec.foundations.survey).toHaveLength(1);

    // contract passes through; roles carry their CTQ slice.
    expect(spec.contract.governancePhase).toBe("shadow");
    expect(spec.roles).toEqual([{ ...ROLES[0], ctqIds: ["ctq1"] }]);
    expect(spec.artifacts).toEqual([GATE_ARTIFACT]);

    // defaults: seed knob, methodology deps, empty registry.
    expect(spec.knobs).toEqual(DEFAULT_KNOBS);
    expect(spec.knobs[0].name).toBe("scanMinSampleSize");
    expect(spec.methodologyDeps).toEqual(DEFAULT_METHODOLOGY_DEPS);
    expect(spec.methodologyDeps).toEqual(["first-principles", "theory-of-constraints", "dmaic"]);
    expect(spec.registryEntry).toEqual({ targets: [], versions: [], metricsLocations: [] });
  });

  it("honors explicit lineage, knobs, and methodologyDeps", () => {
    const spec = assembleProcessSpec(
      assemblyInputs({
        meta: {
          name: "trade-journal",
          version: "0.2.0",
          problemStatement: OBJECTIVE,
          domain: "trading-discipline",
          scalingTier: "complex",
          lineage: { parentVersion: "0.1.0", improvementProposals: ["ip-1"] },
        },
        knobs: [{ name: "reviewBatchSize", purpose: "p", range: { min: 1, max: 10 }, default: 5 }],
        methodologyDeps: ["dmaic"],
      })
    );
    expect(spec.meta.lineage).toEqual({ parentVersion: "0.1.0", improvementProposals: ["ip-1"] });
    expect(spec.knobs.map((k) => k.name)).toEqual(["reviewBatchSize"]);
    expect(spec.methodologyDeps).toEqual(["dmaic"]);
  });

  it("round-trips through the strict disk loader", () => {
    const spec = assembleProcessSpec(assemblyInputs());
    const reloaded = loadProcessSpec(JSON.stringify(spec, null, 2));
    expect(reloaded).toEqual(spec);
  });
});

// ---------------------------------------------------------------------------
// assembleAndValidateSpec
// ---------------------------------------------------------------------------

describe("assembleAndValidateSpec", () => {
  const convergedOutcome = { status: "converged" as const, result: [GATE_ARTIFACT], iterations: 1, history: [] };

  it("returns a clean validation and the planning outcome on a well-formed assembly", () => {
    const result = assembleAndValidateSpec(assemblyInputs(), convergedOutcome);
    expect(failures(result.validation)).toEqual([]);
    expect(result.planningOutcome).toBe(convergedOutcome);
    expect(result.notes).toEqual([]);
    expect(result.spec.meta.name).toBe("trade-journal");
  });

  it("returns validator failures alongside the spec — the caller decides", () => {
    const dangling: Artifact = { ...GATE_ARTIFACT, traceability: { truthIds: ["t9"], constraintIds: [] } };
    const result = assembleAndValidateSpec(assemblyInputs({ artifacts: [dangling] }), convergedOutcome);
    const failed = failures(result.validation);
    expect(failed.map((f) => f.criterionId)).toEqual(["pv-traceability"]);
    expect(failed[0].evidence).toContain("t9");
    expect(result.spec.artifacts).toEqual([dangling]); // spec still returned for inspection
  });

  it("carries the round-robin assembly note", () => {
    const result = assembleAndValidateSpec(
      assemblyInputs({ contractResult: contractResultFixture([{ ...ctqLinkedToT1, metric: "entries per week" }]) }),
      convergedOutcome
    );
    expect(result.notes.some((n) => n.includes("round-robin"))).toBe(true);
    expect(result.spec.roles[0].ctqIds).toEqual(["ctq1"]); // every role still carries a slice
    expect(failures(result.validation)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Structured-output safety (invariant 4) for artifact_plan
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = [
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
  "format",
  "multipleOf",
  "uniqueItems",
  "$ref",
];

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

describe("ArtifactPlanSchema structured-output safety", () => {
  it("no $schema after gateway stripping, closed objects, no numeric/string constraints, no recursion", () => {
    // Mirror both gateways: target "openAi", then delete the root $schema key.
    const jsonSchema = zodToJsonSchema(ArtifactPlanSchema as never, { target: "openAi" }) as Record<string, unknown>;
    delete jsonSchema["$schema"];

    walk(jsonSchema, (obj) => {
      for (const key of FORBIDDEN_KEYS) {
        expect(obj, `forbidden key "${key}" found`).not.toHaveProperty(key);
      }
      if (obj.type === "object") {
        expect(obj.additionalProperties, "object schema must be closed").toBe(false);
      }
    });
  });

  it("elicits exactly the Artifact surface — names are load-bearing, nothing is code-assigned", () => {
    const jsonSchema = zodToJsonSchema(ArtifactPlanSchema as never, { target: "openAi" }) as {
      properties: { artifacts: { items: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(jsonSchema.properties.artifacts.items.properties).sort()).toEqual(
      ["disposition", "kind", "l2Rationale", "name", "relationships", "traceability"].sort()
    );
  });
});
