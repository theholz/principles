import { z } from "zod";
import { Llm } from "../llm/gateway";
import { AgentSpec, Criterion, Critique, Subtask, Truth, failures } from "../shared/types";
import { refine, RefineFeedback, RefineOutcome } from "../shared/refine";
import { judge } from "../shared/judge";
import { Foundations } from "../core/foundations";
import { AssessResult } from "./assess";
import { ContractResult } from "./contract";
import { validateProcessSpec } from "./validators";
import {
  Artifact,
  ConstraintAnalysis,
  Ctq,
  InventoryEntry,
  Knob,
  Lineage,
  ProcessSpec,
  Role,
  ScalingTier,
} from "./types";

/**
 * Stage 4 SPEC — artifact planning + deterministic assembly
 * (design: docs/superpowers/specs/2026-07-20-process-factory-design.md §4
 * stage 4, §6, §7 SPEC row).
 *
 * Two halves:
 *   (a) `planArtifacts` — the ONE LLM step of this stage (`artifact_plan`):
 *       one elicitation call per refine iteration, judged by the L2-routing
 *       and lazy-agent gates (the design's §6 judged tier), escalation
 *       surfaced in the outcome, never blessed (invariant 5);
 *   (b) `assembleProcessSpec` — PURE deterministic assembly of every prior
 *       stage's output into the ProcessSpec shape, followed by the Task-2
 *       mechanical validators (`assembleAndValidateSpec`). Failures are
 *       returned alongside the spec — the caller decides.
 *
 * No web access anywhere in this stage (invariant 1): `surveyLandscape`
 * remains the only sanctioned generation-side web call. This module never
 * sets `webTools`.
 */

// ---------------------------------------------------------------------------
// (a) Artifact planning — schema
// ---------------------------------------------------------------------------

/**
 * Elicitation schema for `artifact_plan`, structured-output-safe
 * (invariant 4): closed objects via zodToJsonSchema target "openAi",
 * z.enum for enums, no numeric/string constraints, no recursion. Its
 * inferred element type is structurally identical to `Artifact` — nothing
 * here is code-assigned, because artifact NAMES are load-bearing
 * (relationships resolve by name, reuse_existing resolves against the
 * inventory by name).
 */
export const ArtifactPlanSchema = z.object({
  artifacts: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["skill", "hook", "gate", "agent", "command", "config"]),
      disposition: z.enum(["reuse_existing", "forge_new", "generate"]),
      traceability: z.object({
        truthIds: z.array(z.string()),
        constraintIds: z.array(z.string()),
      }),
      l2Rationale: z.string(),
      relationships: z.object({
        dependsOn: z.array(z.string()),
        complements: z.array(z.string()),
        composesWith: z.array(z.string()),
        supersedes: z.array(z.string()),
        bindsTools: z.array(z.string()),
      }),
    })
  ),
});

// ---------------------------------------------------------------------------
// (a) Artifact planning — judged tier (design §6)
// ---------------------------------------------------------------------------

/** The judged gates over an artifact plan. Each one is falsifiable. */
export const ARTIFACT_PLAN_RUBRIC: Criterion[] = [
  {
    id: "ap-l2",
    source: "generic",
    description:
      "Every artifact's l2Rationale justifies the intervention TYPE against concrete " +
      "alternatives — why THIS kind (a skill vs a hook vs a gate vs an agent vs a command " +
      "vs config) and why at least one plausible alternative type fails. A rationale that " +
      "only restates what the artifact does, without ruling out an alternative type, FAILS. " +
      "Cite the weakest rationale as evidence.",
  },
  {
    id: "ap-lazy",
    source: "generic",
    description:
      "The lazy-agent test, applied to EVERY hook and gate artifact: for each one, answer " +
      "in your evidence the question \"what is the cheapest path past this gate?\". If the " +
      "cheapest path is a loophole or cosmetic compliance (renaming, an empty stub, pasting " +
      "a placeholder, restating the requirement instead of doing the work) rather than " +
      "actually doing the gated work, that artifact FAILS this criterion. If the plan has " +
      "no hook or gate artifacts, pass with exactly that observation.",
  },
  {
    id: "ap-reuse",
    source: "generic",
    description:
      "Every reuse_existing artifact names, as its artifact name, a real entry from the " +
      "capability inventory listed in the context (exact name match). A reuse_existing " +
      "artifact naming nothing in the inventory FAILS; cite the offending artifact and the " +
      "closest inventory names as evidence. If the plan has no reuse_existing artifacts, " +
      "pass with exactly that observation.",
  },
];

const renderTruth = (t: Truth): string => `- ${t.id} [${t.type}]: ${t.statement}`;
const renderInventoryEntry = (e: InventoryEntry): string =>
  `- ${e.name} [${e.kind}, ${e.status}]${e.location ? ` @ ${e.location}` : ""}`;

/** Pure render of a candidate plan for judging and for revision prompts. */
export function renderArtifactPlanForJudging(artifacts: Artifact[]): string {
  if (artifacts.length === 0) return "(empty artifact plan)";
  return artifacts
    .map((a) => {
      const r = a.relationships;
      const rel = [
        `dependsOn=[${r.dependsOn.join(",")}]`,
        `complements=[${r.complements.join(",")}]`,
        `composesWith=[${r.composesWith.join(",")}]`,
        `supersedes=[${r.supersedes.join(",")}]`,
        `bindsTools=[${r.bindsTools.join(",")}]`,
      ].join(" ");
      return [
        `- ${a.name} [${a.kind}, ${a.disposition}]`,
        `  traceability: truths=[${a.traceability.truthIds.join(",")}] constraints=[${a.traceability.constraintIds.join(",")}]`,
        `  l2Rationale: ${a.l2Rationale}`,
        `  relationships: ${rel}`,
      ].join("\n");
    })
    .join("\n");
}

async function elicitArtifactPlan(
  llm: Llm,
  objective: string,
  truths: Truth[],
  constraint: ConstraintAnalysis,
  subtasks: Subtask[],
  inventory: InventoryEntry[],
  feedback: RefineFeedback<Artifact[]> | null
): Promise<Artifact[]> {
  const feedbackSection = feedback
    ? [
        ``,
        `## Previous artifact plan (REVISE this — do not start over)`,
        renderArtifactPlanForJudging(feedback.previous),
        ``,
        `## What failed — fix exactly these`,
        ...failures(feedback.critique).map((v) => `- ${v.criterionId}: ${v.evidence}`),
        ``,
        `## What passed — PRESERVE these properties`,
        ...feedback.critique.verdicts.filter((v) => v.pass).map((v) => `- ${v.criterionId}: ${v.evidence}`),
      ]
    : [];

  const result = await llm({
    system: [
      "You plan the ARTIFACTS a compiled process needs: one entry per needed capability.",
      "Intervention types (the L2 routing table) — pick the type whose MECHANISM fits:",
      "- skill: reusable knowledge/method loaded on a trigger — for know-how gaps.",
      "- hook: deterministic automation fired on a harness event — for must-happen-every-time mechanics.",
      "- gate: a blocking check that stops work until satisfied — for compliance that must be non-bypassable.",
      "- agent: a dedicated role with its own context — for judgment-heavy responsibilities.",
      "- command: an operator-invoked workflow — for on-demand multi-step procedures.",
      "- config: static settings/permissions — for environment defaults.",
      "Dispositions:",
      "- reuse_existing: the capability already exists — the artifact name MUST be the exact",
      "  name of an entry in the capability inventory below.",
      "- forge_new: a new skill to be produced by skill-forge via handoff.",
      "- generate: the factory emits it directly (hooks, gates, agents, commands, config).",
      "Rules:",
      "- l2Rationale must justify why THIS intervention type over the plausible alternatives",
      "  (why a gate and not a skill; why a hook and not a command) — not restate the artifact.",
      "- For every hook or gate, design it to survive the lazy-agent test: the cheapest path",
      "  past it must be actually doing the work, not cosmetic compliance.",
      "- traceability cites ONLY the truth ids and constraint ids listed below. An artifact",
      "  no truth or constraint demands is an orphan and will be cut.",
      "- relationships name OTHER artifacts in this same plan (bindsTools names tools, not",
      "  artifacts). All five arrays are required on every artifact; empty is fine.",
      "Plan the minimal set that serves the truths and the constraint — no placebo artifacts.",
    ].join("\n"),
    prompt: [
      `## Objective (the process being compiled)`,
      objective,
      ``,
      `## Truths (usable truth ids for traceability)`,
      ...truths.map(renderTruth),
      ``,
      `## Constraint (usable constraint id for traceability)`,
      `- ${constraint.id} [${constraint.type}]: ${constraint.statement}`,
      ``,
      `## Subtasks (the process steps the artifacts must serve)`,
      ...subtasks.map((s) => `- ${s.id}: ${s.description}`),
      ``,
      `## Capability inventory (reuse_existing artifacts MUST name one of these)`,
      ...(inventory.length > 0 ? inventory.map(renderInventoryEntry) : ["(empty)"]),
      ...feedbackSection,
    ].join("\n"),
    schema: ArtifactPlanSchema,
    schemaName: "artifact_plan",
  });

  return result.artifacts;
}

/**
 * Plan the artifact set for a process: elicit (`artifact_plan`) → judge
 * against the L2/lazy-agent/reuse gates → refine (max 3 iterations,
 * critiques fed back, escalation on repeat). The outcome is returned whole:
 * an `escalated`/`exhausted` plan must surface in the compile report, never
 * be silently blessed (invariant 5).
 */
export async function planArtifacts(
  llm: Llm,
  objective: string,
  truths: Truth[],
  constraint: ConstraintAnalysis,
  subtasks: Subtask[],
  inventory: InventoryEntry[]
): Promise<{ artifacts: Artifact[]; outcome: RefineOutcome<Artifact[]> }> {
  const context = [
    `Artifact plan for the process: ${objective}.`,
    `Judge the PLAN itself — each artifact's type choice, gates, and reuse claims.`,
    ``,
    `## Truths and constraint the artifacts may cite`,
    ...truths.map(renderTruth),
    `- ${constraint.id} [${constraint.type}]: ${constraint.statement}`,
    ``,
    `## Capability inventory (reuse_existing must name one of these exactly)`,
    ...(inventory.length > 0 ? inventory.map(renderInventoryEntry) : ["(empty)"]),
  ].join("\n");

  const outcome = await refine<Artifact[]>(
    (feedback) => elicitArtifactPlan(llm, objective, truths, constraint, subtasks, inventory, feedback),
    (candidate) =>
      judge(llm, {
        rubric: ARTIFACT_PLAN_RUBRIC,
        candidate: renderArtifactPlanForJudging(candidate),
        context,
      }),
    { maxIterations: 3 }
  );

  return { artifacts: outcome.result, outcome };
}

// ---------------------------------------------------------------------------
// (b) Deterministic assembly
// ---------------------------------------------------------------------------

/** The scanMinSampleSize knob from the hand-authored seed pattern
 * (seeds/factory-meta/process-spec.json): the default single-loop surface
 * every compiled process is born with. */
export const DEFAULT_KNOBS: Knob[] = [
  {
    name: "scanMinSampleSize",
    purpose:
      "Minimum outcome records required before a scan may file an improvement proposal — the factory refuses to propose from noise.",
    range: { min: 10, max: 100 },
    default: 20,
  },
];

/** Runtime methodology dependencies of every emitted pack (design §3). */
export const DEFAULT_METHODOLOGY_DEPS: string[] = ["first-principles", "theory-of-constraints", "dmaic"];

/** Meta fields the caller supplies; lineage defaults to a parentless v0. */
export interface SpecMetaInputs {
  name: string;
  version: string;
  /** One sentence. */
  problemStatement: string;
  domain: string;
  scalingTier: ScalingTier;
  lineage?: Lineage;
}

export interface SpecAssemblyInputs {
  meta: SpecMetaInputs;
  assessResult: AssessResult;
  /** The UNCHANGED principles-core output (src/core/foundations.ts). */
  foundations: Foundations;
  contractResult: ContractResult;
  roles: AgentSpec[];
  artifacts: Artifact[];
  knobs?: Knob[];
  methodologyDeps?: string[];
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Best-effort role→CTQ mapping. The Ctq type records no machine-readable
 * truth link (the contract judge verifies the semantic link — ct-ctq-truth-
 * link — but only in prose), so the one mechanical signal available is a
 * literal whole-word mention of a truth id in the CTQ's text: a role serving
 * truth T gets every CTQ whose persona/metric/specLimit/defectDefinition
 * mentions T. When no principled mapping exists for a role, the simpler
 * honest rule applies: the role gets one CTQ round-robin (by role index) so
 * every role carries at least one measurable slice — and a note says so.
 */
export function mapRoleCtqs(
  roles: AgentSpec[],
  ctqs: Ctq[]
): { ctqIdsByRole: Record<string, string[]>; notes: string[] } {
  const notes: string[] = [];
  const ctqTexts = ctqs.map((c) => ({
    id: c.id,
    text: `${c.persona} ${c.metric} ${c.specLimit} ${c.defectDefinition}`,
  }));
  const linkedTo = (truthId: string): string[] =>
    ctqTexts.filter((c) => new RegExp(`\\b${escapeRegExp(truthId)}\\b`).test(c.text)).map((c) => c.id);

  const ctqIdsByRole: Record<string, string[]> = {};
  const roundRobinRoles: string[] = [];
  roles.forEach((role, i) => {
    const principled = [...new Set(role.servesTruths.flatMap(linkedTo))];
    if (principled.length > 0) {
      ctqIdsByRole[role.id] = principled;
    } else if (ctqs.length > 0) {
      ctqIdsByRole[role.id] = [ctqs[i % ctqs.length].id];
      roundRobinRoles.push(role.id);
    } else {
      ctqIdsByRole[role.id] = [];
    }
  });

  if (roundRobinRoles.length > 0) {
    notes.push(
      `no principled truth→CTQ link found for role(s) ${roundRobinRoles.join(", ")} — ` +
        `assigned CTQs round-robin so every role carries a measurable slice`
    );
  }
  if (ctqs.length === 0 && roles.length > 0) {
    notes.push(
      `contract carries no CTQs — every role has an empty ctqIds slice and pv-contract-complete will fail`
    );
  }
  return { ctqIdsByRole, notes };
}

/**
 * PURE deterministic assembly of all stage outputs into the ProcessSpec
 * shape (src/factory/types.ts). No LLM, no IO, no clock. Foundations map
 * per the ProcessFoundations contract: truths = skeptic survivals
 * (vet.kept), assumptions = demoted (vet.assumptions), rejected with the
 * winning attack, plus the subtasks/coverageMap/survey unchanged.
 * registryEntry is empty at compile time — it is filled by deploy.
 */
export function assembleProcessSpec(inputs: SpecAssemblyInputs): ProcessSpec {
  const { assessResult, foundations, contractResult, roles, artifacts } = inputs;
  const { ctqIdsByRole } = mapRoleCtqs(roles, contractResult.contract.ctqs);

  const assembledRoles: Role[] = roles.map((r) => ({ ...r, ctqIds: ctqIdsByRole[r.id] ?? [] }));

  return {
    meta: {
      name: inputs.meta.name,
      version: inputs.meta.version,
      problemStatement: inputs.meta.problemStatement,
      domain: inputs.meta.domain,
      scalingTier: inputs.meta.scalingTier,
      lineage: inputs.meta.lineage ?? { parentVersion: null, improvementProposals: [] },
    },
    assessment: assessResult.assessment,
    foundations: {
      truths: foundations.vet.kept,
      assumptions: foundations.vet.assumptions,
      rejected: foundations.vet.rejected,
      subtasks: foundations.subtasks,
      coverageMap: foundations.coverageMap,
      survey: foundations.survey,
    },
    contract: contractResult.contract,
    roles: assembledRoles,
    artifacts,
    knobs: inputs.knobs ?? DEFAULT_KNOBS.map((k) => ({ ...k })),
    methodologyDeps: inputs.methodologyDeps ?? [...DEFAULT_METHODOLOGY_DEPS],
    registryEntry: { targets: [], versions: [], metricsLocations: [] },
  };
}

/** What the compile conductor consumes: spec + mechanical verdicts + the
 * planning outcome + deterministic assembly notes. */
export interface SpecAssemblyResult {
  spec: ProcessSpec;
  /** Task-2 mechanical validators over the assembled spec. Failures are
   * returned alongside — the caller decides what to do with the spec. */
  validation: Critique;
  planningOutcome: RefineOutcome<Artifact[]>;
  /** Deterministic assembly notes (e.g. round-robin CTQ assignment) —
   * surfaced, never silent. */
  notes: string[];
}

/**
 * Assemble, then run the Task-2 mechanical validators. mapRoleCtqs is pure
 * and cheap, so recomputing it here for the notes (assembleProcessSpec
 * keeps the ProcessSpec-only signature) costs nothing and cannot drift.
 */
export function assembleAndValidateSpec(
  inputs: SpecAssemblyInputs,
  planningOutcome: RefineOutcome<Artifact[]>
): SpecAssemblyResult {
  const spec = assembleProcessSpec(inputs);
  const { notes } = mapRoleCtqs(inputs.roles, inputs.contractResult.contract.ctqs);
  return { spec, validation: validateProcessSpec(spec), planningOutcome, notes };
}
