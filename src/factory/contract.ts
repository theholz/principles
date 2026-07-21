import { z } from "zod";
import { Llm } from "../llm/gateway";
import { Truth, Criterion, failures } from "../shared/types";
import { refine, RefineFeedback, RefineOutcome } from "../shared/refine";
import { judge } from "../shared/judge";
import { Contract } from "./types";

/**
 * Stage 3 CONTRACT — DMAIC Define/Measure compiled into the process spec
 * (design: docs/superpowers/specs/2026-07-20-process-factory-design.md §4
 * stage 3, §7 CONTRACT row). One elicitation call per refine iteration,
 * judged by honesty gates: defect definitions must be testable, baselines
 * must be measured or honestly "unmeasured", CTQs must trace to truths.
 *
 * No web access — invariant 1: `surveyLandscape` remains the only sanctioned
 * generation-side web call. This module never sets `webTools`.
 */

/**
 * Elicitation schema, structured-output-safe (invariant 4): closed objects
 * via zodToJsonSchema target `openAi`, no recursion, no numeric/string
 * constraints. Note what is NOT here: `id` (assigned in code, `ctq1`, ...)
 * and `governancePhase` (hardcoded to "shadow" in code — a process is born
 * in shadow; the model never gets a vote on the governance ladder).
 * `baselineJustification` is elicited for the judge (ct-baseline-honest)
 * and dropped from the assembled Contract.
 */
export const ProcessContractSchema = z.object({
  ctqs: z.array(
    z.object({
      persona: z.string(),
      metric: z.string(),
      specLimit: z.string(),
      defectDefinition: z.string(),
    })
  ),
  baseline: z.string(),
  baselineJustification: z.string(),
  decisionRule: z.string(),
  controlPlan: z.object({
    monitoringCadence: z.string(),
    response: z.string(),
  }),
});

/**
 * The judged candidate: a full Contract plus the baseline's justification.
 * The justification exists so ct-baseline-honest has something to check;
 * it is not part of the spec shape and is dropped on assembly.
 */
export interface ContractDraft extends Contract {
  baselineJustification: string;
}

/** The honesty gates. Small on purpose — each one is falsifiable. */
export const CONTRACT_RUBRIC: Criterion[] = [
  {
    id: "ct-defect-testable",
    source: "generic",
    description:
      "Every CTQ's defectDefinition is testable against a concrete example: construct a " +
      "hypothetical artifact the process could produce and decide defect / not-defect from " +
      "the definition alone, with no unstated judgment. Cite the weakest definition and the " +
      "hypothetical you tested it with as evidence.",
  },
  {
    id: "ct-baseline-honest",
    source: "generic",
    description:
      'The baseline is either the literal string "unmeasured" or a concrete value whose ' +
      "stated justification is grounded in the provided objective, truths, or context. " +
      "An unexplained or invented number FAILS this criterion.",
  },
  {
    id: "ct-ctq-truth-link",
    source: "generic",
    description:
      "Each CTQ traces to at least one truth listed in the context — its persona, metric, " +
      "or defect definition demonstrably serves that truth. Name the truth id per CTQ as " +
      "evidence; a CTQ serving no listed truth FAILS.",
  },
];

const renderTruth = (t: Truth): string => `- ${t.id} [${t.type}]: ${t.statement}`;

/** Pure render of a candidate for judging and for revision prompts. */
export function renderContractForJudging(draft: ContractDraft): string {
  return [
    `CTQs:`,
    ...draft.ctqs.map(
      (c) =>
        `- ${c.id} | persona: ${c.persona} | metric: ${c.metric} | spec limit: ${c.specLimit} | defect: ${c.defectDefinition}`
    ),
    `Baseline: ${draft.baseline}`,
    `Baseline justification: ${draft.baselineJustification || "(none)"}`,
    `Decision rule: ${draft.decisionRule}`,
    `Control plan: cadence ${draft.controlPlan.monitoringCadence}; response ${draft.controlPlan.response}`,
  ].join("\n");
}

const judgeContext = (objective: string, truths: Truth[], feedbackContext?: string): string =>
  [
    `This is the DMAIC Define/Measure contract for the process: ${objective}.`,
    `Judge the CONTRACT itself, not the process it governs.`,
    ``,
    `## Truths every CTQ must trace to`,
    ...truths.map(renderTruth),
    ...(feedbackContext ? [``, `## Additional context`, feedbackContext] : []),
  ].join("\n");

/**
 * One elicitation attempt. With feedback this is a revision, not a re-roll:
 * the previous candidate, the failed criteria (with evidence), and what
 * passed (to preserve) all go into the prompt.
 */
async function elicitContract(
  llm: Llm,
  objective: string,
  truths: Truth[],
  roles: { id: string; name: string }[] | undefined,
  feedbackContext: string | undefined,
  feedback: RefineFeedback<ContractDraft> | null
): Promise<ContractDraft> {
  const rolesSection =
    roles && roles.length > 0
      ? [``, `## Roles operating the process (candidate personas)`, ...roles.map((r) => `- ${r.id}: ${r.name}`)]
      : [];
  const contextSection = feedbackContext ? [``, `## Additional context`, feedbackContext] : [];
  const feedbackSection = feedback
    ? [
        ``,
        `## Previous attempt (REVISE this — do not start over)`,
        renderContractForJudging(feedback.previous),
        ``,
        `## What failed — fix exactly these`,
        ...failures(feedback.critique).map((v) => `- ${v.criterionId}: ${v.evidence}`),
        ``,
        `## What passed — PRESERVE these properties`,
        ...feedback.critique.verdicts.filter((v) => v.pass).map((v) => `- ${v.criterionId}: ${v.evidence}`),
      ]
    : [];

  const raw = await llm({
    system: [
      "You compile the DMAIC Define/Measure contract for a process.",
      "Produce:",
      "- ctqs: critical-to-quality metrics. Each names the persona who cares about it, the",
      "  metric, the spec limit (the threshold separating acceptable from defective), and a",
      "  defectDefinition precise enough that anyone holding a concrete example of the",
      "  process's output can decide defect / not-defect from the definition alone.",
      "- Every CTQ must trace to at least one of the provided truths. A metric no truth",
      "  demands is measurement theater — leave it out.",
      "- baseline: the current measured value of the primary metric. Give a concrete value",
      "  ONLY if you can justify it from the objective, truths, or context provided here —",
      "  and put that justification in baselineJustification. If no measurement exists in",
      '  the provided material, baseline is the literal string "unmeasured" and',
      "  baselineJustification is an empty string. NEVER invent a number: an honest",
      '  "unmeasured" is correct; a plausible-sounding guess is a defect.',
      "- decisionRule: the rule that decides, from outcomes, whether the process is working",
      "  or needs intervention (tie it to the spec limits).",
      "- controlPlan: monitoringCadence (how often outcomes are read against the decision",
      "  rule) and response (what happens when the rule trips).",
    ].join("\n"),
    prompt: [
      `## Objective (the process under contract)`,
      objective,
      ``,
      `## Truths (every CTQ must trace to at least one of these ids)`,
      ...truths.map(renderTruth),
      ...rolesSection,
      ...contextSection,
      ...feedbackSection,
    ].join("\n"),
    schema: ProcessContractSchema,
    schemaName: "process_contract",
  });

  // Explicit field mapping: ids are code-assigned, governancePhase is
  // hardcoded — whatever the model returned for either is ignored. A process
  // is born in shadow (design §4 stage 3); promotion up the ladder is an
  // operator act, never a compilation output.
  return {
    ctqs: raw.ctqs.map((c, i) => ({
      id: `ctq${i + 1}`,
      persona: c.persona,
      metric: c.metric,
      specLimit: c.specLimit,
      defectDefinition: c.defectDefinition,
    })),
    baseline: raw.baseline.trim(),
    decisionRule: raw.decisionRule,
    controlPlan: {
      monitoringCadence: raw.controlPlan.monitoringCadence,
      response: raw.controlPlan.response,
    },
    governancePhase: "shadow",
    baselineJustification: raw.baselineJustification.trim(),
  };
}

/** What Task 7's assembly consumes: the contract plus the full refine outcome. */
export interface ContractResult {
  /** The last candidate, assembled into the spec shape (justification dropped). */
  contract: Contract;
  /**
   * The full refine outcome over the judged draft. `escalated` / `exhausted`
   * must surface in the assembled spec's report — never silently bless
   * (invariant 5). `RefineOutcome<ContractDraft>` is assignable wherever a
   * `RefineOutcome<Contract>` is expected.
   */
  outcome: RefineOutcome<ContractDraft>;
}

/**
 * Derive the stage-3 contract: elicit → judge against the honesty gates →
 * refine (max 3 iterations, critiques fed back, escalation on repeat).
 */
export async function deriveContract(
  llm: Llm,
  objective: string,
  truths: Truth[],
  roles?: { id: string; name: string }[],
  feedbackContext?: string
): Promise<ContractResult> {
  const outcome = await refine<ContractDraft>(
    (feedback) => elicitContract(llm, objective, truths, roles, feedbackContext, feedback),
    (candidate) =>
      judge(llm, {
        rubric: CONTRACT_RUBRIC,
        candidate: renderContractForJudging(candidate),
        context: judgeContext(objective, truths, feedbackContext),
      }),
    { maxIterations: 3 }
  );

  const { baselineJustification: _justification, ...contract } = outcome.result;
  return { contract, outcome };
}
