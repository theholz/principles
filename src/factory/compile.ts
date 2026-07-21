import * as nodeFs from "fs";
import { Llm } from "../llm/gateway";
import { failures } from "../shared/types";
import { RefineOutcome } from "../shared/refine";
import { deriveFoundations } from "../core/foundations";
import { generateAgentSpecs } from "../core/specs";
import { assess, AssessFs, AssessResult, EngramClient } from "./assess";
import { deriveContract } from "./contract";
import { assembleAndValidateSpec, planArtifacts, SpecAssemblyInputs } from "./spec";
import { InventoryEntry, InventoryStatus, ProcessSpec, ScalingTier } from "./types";

/**
 * COMPILE — the pipeline conductor for stages 1–4 (design:
 * docs/superpowers/specs/2026-07-20-process-factory-design.md §4):
 * ASSESS → enriched DECOMPOSE (existing core, unchanged) → CONTRACT →
 * SPEC (roles + artifact plan + deterministic assembly + validators).
 *
 * THE HITL GATE IS STRUCTURAL: compile NEVER emits a pack. Its terminal
 * success state is a process spec written to disk (or returned in memory)
 * awaiting operator approval; emission is a separate, human-invoked CLI
 * step (`factory emit <spec>`). There is deliberately no code path from
 * here to the emitter.
 *
 * Invariant 1: this module never sets `webTools`. The only web call in the
 * whole compile is `surveyLandscape` inside deriveFoundations, gated by
 * `opts.webSurvey` — the caller decides via providerSupportsWebTools
 * (src/llm/resolveLlm.ts) whether the provider can honor it.
 *
 * Invariant 5: refine escalations from every judged stage (decomposition,
 * contract, artifact planning) are collected into `escalations` and
 * surfaced in the report — never silently blessed. Mechanical validation
 * failures return the spec for inspection but never write it to disk.
 */

export interface CompileOptions {
  /** Inventory roots for the ASSESS scan (see AssessOptions.roots). */
  roots: string[];
  /**
   * Whether deriveFoundations may run the landscape survey (the one
   * sanctioned generation-side web call). Pass
   * providerSupportsWebTools() when resolving the LLM from the CLI.
   */
  webSurvey: boolean;
  fs?: AssessFs;
  engram?: EngramClient;
  scalingTier?: ScalingTier;
  domain?: string;
  /** Where to write the spec JSON on the spec_ready path. Never written on
   * any other path. */
  outPath?: string;
  /** Injected writer (defaults to fs.writeFileSync) — tests stay network-
   * and disk-free. */
  writeFile?: (path: string, content: string) => void;
}

export type CompileStatus = "spec_ready" | "build_nothing" | "validation_failed";

export interface CompileResult {
  status: CompileStatus;
  /** Present on spec_ready AND validation_failed (returned for inspection);
   * absent on build_nothing. */
  spec?: ProcessSpec;
  /** Human-readable summary lines. */
  report: string[];
  assessResult: AssessResult;
  /** Non-converged judged stages, surfaced (invariant 5). */
  escalations: string[];
}

/** Assert-able marker prefixing every enriched objective (design §4 [2]). */
export const ENRICHMENT_MARKER = "## Environment assessment";

const STATUS_ORDER: Record<InventoryStatus, number> = { built: 0, partial: 1, gap: 2 };

const renderInventoryEntry = (e: InventoryEntry): string =>
  `- ${e.name} [${e.kind}, ${e.status}]${e.location ? ` @ ${e.location}` : ""}`;

/**
 * Stage-2 goal enrichment: the objective handed to deriveFoundations is the
 * problem PREFIXED with a compact assessment summary — constraint statement
 * plus top inventory hits — so truths ground in the actual environment.
 * Existing capabilities (built, then partial) sort before gaps; the list is
 * capped so the prefix stays compact.
 */
export function enrichObjective(problem: string, assessResult: AssessResult): string {
  const { triageVerdict, constraint, inventory } = assessResult.assessment;
  const top = [...inventory].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]).slice(0, 8);
  return [
    ENRICHMENT_MARKER,
    `Triage: ${triageVerdict.verdict} — ${triageVerdict.evidence}`,
    `Constraint (${constraint.id}, ${constraint.type}): ${constraint.statement}`,
    `Top inventory:`,
    ...(top.length > 0 ? top.map(renderInventoryEntry) : ["- (none)"]),
    ``,
    `## Problem`,
    problem,
  ].join("\n");
}

/** Deterministic spec name from the problem statement. */
const slugify = (problem: string): string => {
  const slug = problem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "unnamed-process";
};

/** One escalation line per non-converged judged stage. */
const escalationLine = (stage: string, outcome: RefineOutcome<unknown>): string =>
  `${stage} ${outcome.status}` +
  (outcome.status === "escalated" ? ` (stuck on ${outcome.stuckOn.join(", ")})` : "") +
  ` after ${outcome.iterations} iteration(s)`;

export async function compileProcess(llm: Llm, problem: string, opts: CompileOptions): Promise<CompileResult> {
  const report: string[] = [];
  const escalations: string[] = [];

  // [1] ASSESS — deterministic scan + judged triage + skeptic-vetted constraint.
  const assessResult = await assess(llm, problem, { roots: opts.roots, fs: opts.fs, engram: opts.engram });
  const { triageVerdict, inventory, constraint } = assessResult.assessment;
  report.push(`Triage: ${triageVerdict.verdict} — ${triageVerdict.evidence}`);
  for (const note of assessResult.notes) report.push(`Assess note: ${note}`);

  // Invariant 5: assess-stage non-convergence (a triage verdict the judge
  // never passed, a constraint claim the skeptic broke twice) belongs in the
  // loud escalation channel, not only in the report notes. Matched on the
  // STABLE note prefixes assess() emits (src/factory/assess.ts) so the two
  // channels cannot drift apart silently.
  const ASSESS_ESCALATION_PREFIXES = [
    "triage verdict did not converge",
    "constraint claim did not survive skepticism",
  ];
  for (const note of assessResult.notes) {
    if (ASSESS_ESCALATION_PREFIXES.some((p) => note.startsWith(p))) {
      escalations.push(`assess ${note}`);
    }
  }

  // "Build nothing" is a valid, cheap outcome (design §4 [1], §9) — exit clean.
  if (triageVerdict.verdict === "use_existing" || triageVerdict.verdict === "compose") {
    const matched = inventory.filter((e) => e.status !== "gap");
    report.push(
      `Build nothing — the ${triageVerdict.verdict} verdict says existing capabilities cover the need.`
    );
    if (matched.length > 0) {
      report.push(`Matched inventory:`);
      report.push(...matched.map(renderInventoryEntry));
    } else {
      report.push(`Matched inventory: (verdict cited no built/partial entries — see evidence above)`);
    }
    return { status: "build_nothing", report, assessResult, escalations };
  }

  // [2] DECOMPOSE — existing core, unchanged; goal enriched with the assessment.
  const enriched = enrichObjective(problem, assessResult);
  const foundations = await deriveFoundations(llm, enriched, { webSurvey: opts.webSurvey });
  if (foundations.decomposition.status !== "converged") {
    escalations.push(escalationLine("foundations decomposition", foundations.decomposition));
  }
  report.push(
    `Foundations: ${foundations.vet.kept.length} truth(s), ${foundations.vet.assumptions.length} assumption(s), ` +
      `${foundations.vet.rejected.length} rejected; ${foundations.subtasks.length} subtask(s)`
  );

  // [3] CONTRACT — DMAIC Define/Measure over the vetted truths; the compact
  // assessment summary travels as feedbackContext (roles do not exist yet).
  const contractContext = [
    `Assessment summary — triage: ${triageVerdict.verdict}.`,
    `Constraint (${constraint.id}, ${constraint.type}): ${constraint.statement}`,
  ].join("\n");
  const contractResult = await deriveContract(llm, problem, foundations.truths, undefined, contractContext);
  if (contractResult.outcome.status !== "converged") {
    escalations.push(escalationLine("contract", contractResult.outcome));
  }
  report.push(
    `Contract: ${contractResult.contract.ctqs.length} CTQ(s); baseline ${contractResult.contract.baseline}; ` +
      `governance ${contractResult.contract.governancePhase}`
  );

  // [4a] Roles — existing core, unchanged.
  const roles = await generateAgentSpecs(llm, problem, foundations.truths, foundations.subtasks);
  report.push(`Roles: ${roles.length}`);

  // [4b] Artifact plan (judged) + deterministic assembly + mechanical validators.
  const { artifacts, outcome: planningOutcome } = await planArtifacts(
    llm,
    problem,
    foundations.truths,
    constraint,
    foundations.subtasks,
    inventory
  );
  if (planningOutcome.status !== "converged") {
    escalations.push(escalationLine("artifact planning", planningOutcome));
  }

  const assemblyInputs: SpecAssemblyInputs = {
    meta: {
      name: slugify(problem),
      version: "0.1.0",
      problemStatement: problem,
      domain: opts.domain ?? "general",
      scalingTier: opts.scalingTier ?? "medium",
      lineage: { parentVersion: null, improvementProposals: [] },
    },
    assessResult,
    foundations,
    contractResult,
    roles,
    artifacts,
  };
  const assembled = assembleAndValidateSpec(assemblyInputs, planningOutcome);
  const byDisposition = (d: string) => artifacts.filter((a) => a.disposition === d).length;
  report.push(
    `Artifacts: ${artifacts.length} (${byDisposition("reuse_existing")} reuse_existing / ` +
      `${byDisposition("forge_new")} forge_new / ${byDisposition("generate")} generate)`
  );
  for (const note of assembled.notes) report.push(`Assembly note: ${note}`);
  for (const line of escalations) report.push(`ESCALATION: ${line}`);

  const failed = failures(assembled.validation);
  if (failed.length > 0) {
    report.push(`Mechanical validation FAILED — spec returned for inspection, NOT written to disk:`);
    for (const f of failed) report.push(`  - ${f.criterionId}: ${f.evidence}`);
    return { status: "validation_failed", spec: assembled.spec, report, assessResult, escalations };
  }
  report.push(`Mechanical validation passed (${assembled.validation.verdicts.length} criteria).`);

  if (opts.outPath) {
    const write = opts.writeFile ?? ((p: string, c: string) => nodeFs.writeFileSync(p, c));
    write(opts.outPath, JSON.stringify(assembled.spec, null, 2) + "\n");
    report.push(`Spec written to ${opts.outPath}.`);
  }
  report.push(
    `Spec ready — awaiting operator approval (HITL gate). Emission is a separate step: factory emit <spec>.`
  );
  return { status: "spec_ready", spec: assembled.spec, report, assessResult, escalations };
}
