import { describe, it, expect } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  deriveContract,
  ProcessContractSchema,
  CONTRACT_RUBRIC,
  renderContractForJudging,
} from "../../src/factory/contract";
import { Truth } from "../../src/shared/types";
import { Llm, LlmRequest } from "../../src/llm/gateway";

const truths: Truth[] = [
  { id: "t1", type: "constraint", statement: "Every deploy lands as a draft PR", rationale: "" },
  { id: "t2", type: "fact", statement: "No outcome data exists before first deploy", rationale: "" },
];

/** What a fake returns for process_contract. Includes fields the model must
 * NOT control: governancePhase (hardcoded in code) and id (code-assigned). */
const goodResponse = {
  ctqs: [
    {
      id: "model-picked-id",
      persona: "operator",
      metric: "deploys landing via draft PR",
      specLimit: "100%",
      defectDefinition: "a deploy that reaches main without a draft PR",
    },
  ],
  baseline: "unmeasured",
  baselineJustification: "",
  decisionRule: "any defect in a monitoring window triggers an improvement proposal",
  controlPlan: { monitoringCadence: "weekly", response: "open improvement proposal" },
  governancePhase: "enforcement", // model tries to skip the shadow ladder — must be ignored
};

const passAll = {
  verdicts: CONTRACT_RUBRIC.map((c) => ({
    criterionId: c.id,
    pass: true,
    evidence: `criterion ${c.id} satisfied with cited content`,
  })),
};

const BASELINE_ATTACK = 'baseline "97%" has no justification grounded in the provided context';
const failBaseline = {
  verdicts: [
    { criterionId: "ct-defect-testable", pass: true, evidence: "defect decidable from definition alone" },
    { criterionId: "ct-baseline-honest", pass: false, evidence: BASELINE_ATTACK },
    { criterionId: "ct-ctq-truth-link", pass: true, evidence: "ctq1 serves t1 draft-PR constraint" },
  ],
};

describe("deriveContract", () => {
  it("assembles the contract: code-assigned ctq ids, hardcoded shadow phase, truths rendered everywhere, never web", async () => {
    const requests: LlmRequest<unknown>[] = [];
    const llm = (async (req: LlmRequest<unknown>) => {
      requests.push(req);
      if (req.schemaName === "process_contract") return goodResponse;
      if (req.schemaName === "rubric_verdicts") return passAll;
      throw new Error(`unexpected ${req.schemaName}`);
    }) as unknown as Llm;

    const { contract, outcome } = await deriveContract(llm, "operate the process factory", truths);

    expect(outcome.status).toBe("converged");
    expect(outcome.iterations).toBe(1);
    expect(contract.ctqs.map((c) => c.id)).toEqual(["ctq1"]); // not "model-picked-id"
    expect(contract.governancePhase).toBe("shadow"); // fake said "enforcement"
    expect(contract.baseline).toBe("unmeasured");
    expect(contract.controlPlan).toEqual({ monitoringCadence: "weekly", response: "open improvement proposal" });
    expect((contract as Record<string, unknown>).baselineJustification).toBeUndefined(); // dropped on assembly

    // truths rendered into the elicitation prompt AND the judge context (ct-ctq-truth-link needs them):
    const elicit = requests.find((r) => r.schemaName === "process_contract")!;
    expect(elicit.prompt).toContain("t1 [constraint]: Every deploy lands as a draft PR");
    const judgeReq = requests.find((r) => r.schemaName === "rubric_verdicts")!;
    expect(judgeReq.prompt).toContain("Every deploy lands as a draft PR");
    expect(judgeReq.prompt).toContain("ct-defect-testable");

    // invariant 1: this stage never requests web tools
    expect(requests.every((r) => r.webTools === undefined)).toBe(true);
  });

  it("renders roles and feedback context into the elicitation prompt when provided", async () => {
    let elicitPrompt = "";
    const llm = (async (req: LlmRequest<unknown>) => {
      if (req.schemaName === "process_contract") {
        elicitPrompt = req.prompt;
        return goodResponse;
      }
      if (req.schemaName === "rubric_verdicts") return passAll;
      throw new Error(`unexpected ${req.schemaName}`);
    }) as unknown as Llm;

    await deriveContract(
      llm,
      "operate the process factory",
      truths,
      [{ id: "agent-s1", name: "Intake triager" }],
      "Assessment summary: create_new verdict; constraint c1 is review throughput."
    );

    expect(elicitPrompt).toContain("agent-s1: Intake triager");
    expect(elicitPrompt).toContain("Assessment summary: create_new verdict");
  });

  it("feeds the invented-baseline critique back and converges on the honest revision", async () => {
    const contractPrompts: string[] = [];
    let judgeCalls = 0;
    const llm = (async (req: LlmRequest<unknown>) => {
      if (req.schemaName === "process_contract") {
        contractPrompts.push(req.prompt);
        return contractPrompts.length === 1
          ? { ...goodResponse, baseline: "97%", baselineJustification: "" } // invented number
          : { ...goodResponse, baseline: "unmeasured" }; // honest revision
      }
      if (req.schemaName === "rubric_verdicts") return ++judgeCalls === 1 ? failBaseline : passAll;
      throw new Error(`unexpected ${req.schemaName}`);
    }) as unknown as Llm;

    const { contract, outcome } = await deriveContract(llm, "operate the process factory", truths);

    expect(outcome.status).toBe("converged");
    expect(outcome.iterations).toBe(2);
    expect(contract.baseline).toBe("unmeasured");
    expect(contractPrompts).toHaveLength(2);
    // the second elicitation is a REVISION: previous candidate + the judge's critique evidence
    expect(contractPrompts[1]).toContain("Baseline: 97%");
    expect(contractPrompts[1]).toContain(`ct-baseline-honest: ${BASELINE_ATTACK}`);
    // and what passed is preserved, not re-litigated:
    expect(contractPrompts[1]).toContain("ct-defect-testable: defect decidable from definition alone");
  });

  it("escalates on persistent failure and surfaces the outcome — never silently blesses", async () => {
    let elicitations = 0;
    const llm = (async (req: LlmRequest<unknown>) => {
      if (req.schemaName === "process_contract") {
        elicitations++;
        return { ...goodResponse, baseline: "97%", baselineJustification: "" };
      }
      if (req.schemaName === "rubric_verdicts") return failBaseline;
      throw new Error(`unexpected ${req.schemaName}`);
    }) as unknown as Llm;

    const { contract, outcome } = await deriveContract(llm, "operate the process factory", truths);

    expect(outcome.status).toBe("escalated"); // same criterion failed twice — no third re-roll
    if (outcome.status === "escalated") expect(outcome.stuckOn).toEqual(["ct-baseline-honest"]);
    expect(elicitations).toBe(2);
    expect(outcome.history).toHaveLength(2);
    // the unconverged contract is returned AS unconverged — Task 7 must surface it, not bless it
    expect(contract.baseline).toBe("97%");
    expect(contract.governancePhase).toBe("shadow"); // hardcoded even on failure paths
  });
});

describe("renderContractForJudging", () => {
  it("carries the baseline justification so ct-baseline-honest has something to judge", () => {
    const draft = {
      ctqs: [{ id: "ctq1", persona: "p", metric: "m", specLimit: "s", defectDefinition: "d" }],
      baseline: "3 defects/week",
      baselineJustification: "counted from the objective's incident log excerpt",
      decisionRule: "rule",
      controlPlan: { monitoringCadence: "daily", response: "halt" },
      governancePhase: "shadow" as const,
    };
    const rendered = renderContractForJudging(draft);
    expect(rendered).toContain("Baseline: 3 defects/week");
    expect(rendered).toContain("Baseline justification: counted from the objective's incident log excerpt");
    expect(renderContractForJudging({ ...draft, baselineJustification: "" })).toContain(
      "Baseline justification: (none)"
    );
  });
});

// ---------------------------------------------------------------------------
// Structured-output safety (invariant 4)
// ---------------------------------------------------------------------------

const CONSTRAINT_KEYS = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  if (node && typeof node === "object") {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}

describe("ProcessContractSchema structured-output safety", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = zodToJsonSchema(ProcessContractSchema as any, { target: "openAi" }) as Record<string, unknown>;

  it("emits the root $schema meta-key the gateways strip — and nowhere else", () => {
    // The gateways `delete jsonSchema["$schema"]` at the ROOT only (the Agent
    // SDK CLI silently skips structured output when it is present). A nested
    // $schema would survive that strip — assert none exists.
    const nested: string[] = [];
    walk(json, (obj) => {
      if ("$schema" in obj && obj !== json) nested.push(JSON.stringify(Object.keys(obj)));
    });
    expect(nested).toEqual([]);
  });

  it("closes every object and carries no numeric/string constraint keywords", () => {
    const problems: string[] = [];
    walk(json, (obj) => {
      if (obj.type === "object" && obj.additionalProperties !== false) {
        problems.push(`open object with keys ${JSON.stringify(Object.keys(obj.properties ?? {}))}`);
      }
      for (const key of Object.keys(obj)) {
        if (CONSTRAINT_KEYS.has(key)) problems.push(`constraint key "${key}"`);
      }
    });
    expect(problems).toEqual([]);
  });

  it("has no recursion", () => {
    expect(JSON.stringify(json)).not.toContain("$ref");
  });

  it("does not elicit id or governancePhase — those are code-owned", () => {
    const rootProps = json.properties as Record<string, unknown>;
    expect(Object.keys(rootProps).sort()).toEqual(
      ["baseline", "baselineJustification", "controlPlan", "ctqs", "decisionRule"].sort()
    );
    const ctqItems = (rootProps.ctqs as { items: { properties: Record<string, unknown> } }).items;
    expect(Object.keys(ctqItems.properties).sort()).toEqual(
      ["defectDefinition", "metric", "persona", "specLimit"].sort()
    );
  });
});
