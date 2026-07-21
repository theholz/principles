import { z } from "zod";
import * as nodeFs from "fs";
import { Llm } from "../llm/gateway";
import { Truth, Observation, Criterion, Critique, failures } from "../shared/types";
import { refine, RefineFeedback } from "../shared/refine";
import { judge } from "../shared/judge";
import { vetTruths, VetResult } from "../core/skeptic";
import { Assessment, ConstraintAnalysis, InventoryEntry, TriageVerdict } from "./types";

/**
 * ASSESS — stage 1 of the process factory (design spec §4 [1], §7 row 1):
 * feature-framework mechanized.
 *
 * Three parts:
 *   (a) deterministic inventory scan — injected fs over configured roots plus
 *       an optional injected Engram interface; pure code, no LLM, degrades
 *       gracefully when a root or Engram is unavailable (never fails the run);
 *   (b) LLM classification of the scanned candidates (`capability_inventory`)
 *       and a forge-threshold triage verdict (`triage_verdict`) run through
 *       the existing evidence-requiring judge inside a refine loop;
 *   (c) TOC constraint analysis (`constraint_analysis`) whose constraint claim
 *       is adversarially vetted by mapping it into a Truth and routing it
 *       through the existing skeptic (vetTruths / `truth_attack`). A rejected
 *       claim is refined with the attack as feedback; a claim that still does
 *       not survive is SURFACED via notes, never silently blessed (invariant 5).
 *
 * No web access anywhere in this stage (invariant 1): `surveyLandscape`
 * remains the only sanctioned generation-side web call, and it is not here.
 */

// ---------------------------------------------------------------------------
// LLM schemas (structured-output-safe: closed via zodToJsonSchema target
// "openAi", z.enum for enums, no numeric/string constraints, no recursion)
// ---------------------------------------------------------------------------

export const CapabilityInventorySchema = z.object({
  inventory: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      location: z.string(),
      status: z.enum(["built", "partial", "gap"]),
    })
  ),
});

export const TriageVerdictSchema = z.object({
  verdict: z.enum(["use_existing", "improve_existing", "compose", "create_new"]),
  evidence: z.string(),
});

export const ConstraintAnalysisSchema = z.object({
  flowSteps: z.array(z.string()),
  statement: z.string(),
  type: z.enum(["policy", "physical", "knowledge", "paradigm", "market", "material"]),
  exploitOptions: z.array(z.string()),
  subordinateOptions: z.array(z.string()),
  elevateOptions: z.array(z.string()),
  evidence: z.string(),
});

// ---------------------------------------------------------------------------
// Injected interfaces
// ---------------------------------------------------------------------------

/** Minimal synchronous fs surface the inventory scan needs (injectable for tests). */
export interface AssessFs {
  readdir(path: string): string[];
  readFile(path: string): string;
  exists(path: string): boolean;
}

export interface EngramSkillHit {
  name: string;
  location?: string;
}

/** Optional live Engram skill-router query. Unavailability NEVER fails the run. */
export interface EngramClient {
  querySkills(query: string): Promise<EngramSkillHit[]>;
}

export interface AssessOptions {
  /** Inventory roots to scan (e.g. an engram-plugins checkout's plugins/ dir, local skills dirs). */
  roots: string[];
  fs?: AssessFs;
  engram?: EngramClient;
}

/**
 * Assessment (src/factory/types.ts) has no field for scan provenance, and the
 * loader's AssessmentSchema is strict — so scan facts travel on this wrapper,
 * not on the spec type.
 */
export interface AssessResult {
  assessment: Assessment;
  /** Roots that existed and were scanned. */
  scannedRoots: string[];
  /** Roots that did not exist and were skipped. */
  unavailableRoots: string[];
  /** Degradations and unverified-surface notes (missing roots, Engram unavailability, non-converged triage, constraint-claim skepticism failure). */
  notes: string[];
}

const realFs: AssessFs = {
  readdir: (p) => nodeFs.readdirSync(p),
  readFile: (p) => nodeFs.readFileSync(p, "utf8"),
  exists: (p) => nodeFs.existsSync(p),
};

// ---------------------------------------------------------------------------
// (a) Deterministic inventory scan — pure fs code, no LLM
// ---------------------------------------------------------------------------

/** A raw capability candidate found by the deterministic scan (pre-classification). */
export interface ScanCandidate {
  name: string;
  /** "plugin" | "skill" | "hook" — free-form to match InventoryEntry.kind. */
  kind: string;
  location: string;
  /** SKILL.md frontmatter description when available; empty otherwise. */
  hint: string;
  source: "fs" | "engram";
}

export interface ScanResult {
  candidates: ScanCandidate[];
  scannedRoots: string[];
  unavailableRoots: string[];
}

const safeReaddir = (fs: AssessFs, p: string): string[] => {
  try {
    return fs.readdir(p);
  } catch {
    return [];
  }
};

const skillDescription = (fs: AssessFs, skillMdPath: string): string => {
  try {
    const m = fs.readFile(skillMdPath).match(/^description:\s*(.+)$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
};

/**
 * Walk the configured roots collecting capability candidates: plugin dirs
 * (marked by .claude-plugin/plugin.json), skills (skills/<name>/SKILL.md, or a
 * root-level <name>/SKILL.md for bare skill dirs), and hook files. A missing
 * root is skipped silently here and reported via unavailableRoots.
 */
export function scanRoots(fs: AssessFs, roots: string[]): ScanResult {
  const candidates: ScanCandidate[] = [];
  const scannedRoots: string[] = [];
  const unavailableRoots: string[] = [];
  const seen = new Set<string>();

  const add = (c: ScanCandidate) => {
    const key = `${c.kind}:${c.name}:${c.location}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };

  for (const root of roots) {
    if (!fs.exists(root)) {
      unavailableRoots.push(root);
      continue;
    }
    scannedRoots.push(root);

    for (const entry of safeReaddir(fs, root)) {
      const dir = `${root}/${entry}`;

      if (fs.exists(`${dir}/.claude-plugin/plugin.json`)) {
        add({ name: entry, kind: "plugin", location: dir, hint: "", source: "fs" });
      }
      if (fs.exists(`${dir}/SKILL.md`)) {
        add({ name: entry, kind: "skill", location: dir, hint: skillDescription(fs, `${dir}/SKILL.md`), source: "fs" });
      }
      const skillsDir = `${dir}/skills`;
      if (fs.exists(skillsDir)) {
        for (const skill of safeReaddir(fs, skillsDir)) {
          const skillMd = `${skillsDir}/${skill}/SKILL.md`;
          if (fs.exists(skillMd)) {
            add({ name: skill, kind: "skill", location: `${skillsDir}/${skill}`, hint: skillDescription(fs, skillMd), source: "fs" });
          }
        }
      }
      const hooksDir = `${dir}/hooks`;
      if (fs.exists(hooksDir)) {
        for (const hook of safeReaddir(fs, hooksDir)) {
          add({ name: hook.replace(/\.[^.]+$/, ""), kind: "hook", location: `${hooksDir}/${hook}`, hint: "", source: "fs" });
        }
      }
    }
  }

  return { candidates, scannedRoots, unavailableRoots };
}

/**
 * Sentinel recorded when the injected Engram interface throws: the router is a
 * capability source we could not consult — an honest gap, appended in code so
 * no LLM step can drop it.
 */
const ENGRAM_SENTINEL: InventoryEntry = {
  name: "engram-router",
  kind: "service",
  location: "source unavailable",
  status: "gap",
};

// ---------------------------------------------------------------------------
// (b) LLM classification + judged triage
// ---------------------------------------------------------------------------

const renderCandidate = (c: ScanCandidate): string =>
  `- ${c.name} [${c.kind}] @ ${c.location} (source: ${c.source})${c.hint ? ` — ${c.hint}` : ""}`;

const renderInventoryEntry = (e: InventoryEntry): string =>
  `- ${e.name} [${e.kind}, ${e.status}]${e.location ? ` @ ${e.location}` : ""}`;

async function classifyInventory(llm: Llm, problem: string, candidates: ScanCandidate[]): Promise<InventoryEntry[]> {
  const result = await llm({
    system: [
      "You classify an environment's scanned capabilities against a problem (feature-framework",
      "inventory discipline: confirm gaps, don't assume them).",
      "For each capability RELEVANT to the problem, emit one entry with a status:",
      "- built: exists and substantially covers what the problem needs from it.",
      "- partial: exists but covers the need incompletely.",
      "- gap: needed but missing. You may ADD gap entries for needed capabilities absent from",
      "  the scan; a pure gap's location is an empty string.",
      "Never mark a capability built or partial unless it appears in the scanned candidates —",
      "inventing existing capabilities is the failure mode this stage exists to prevent.",
      "Keep kind free-form but honest (skill, plugin, hook, pipeline, service, ...).",
    ].join("\n"),
    prompt: [
      `## Problem`,
      problem,
      ``,
      `## Scanned candidates`,
      ...(candidates.length > 0 ? candidates.map(renderCandidate) : ["(none found)"]),
    ].join("\n"),
    schema: CapabilityInventorySchema,
    schemaName: "capability_inventory",
  });
  return result.inventory;
}

/** Small evidence-requiring rubric for the triage verdict (skill-forge thresholds). */
export const triageRubric: Criterion[] = [
  {
    id: "a-cites",
    description:
      "The evidence names specific inventory entries (by name) that ground the verdict — or states explicitly that the inventory contains no relevant capability.",
    source: "generic",
  },
  {
    id: "a-threshold",
    description:
      "The verdict is consistent with the skill-forge thresholds: use_existing only when cited existing capabilities cover >=80% of the need; improve_existing for 50-79% coverage; compose when the need spans multiple existing capabilities combined across domains; create_new otherwise.",
    source: "generic",
  },
];

async function elicitTriage(
  llm: Llm,
  problem: string,
  inventory: InventoryEntry[],
  feedback: RefineFeedback<TriageVerdict> | null
): Promise<TriageVerdict> {
  const feedbackSection = feedback
    ? [
        ``,
        `## Previous verdict (REVISE this — do not start over)`,
        `verdict: ${feedback.previous.verdict}`,
        `evidence: ${feedback.previous.evidence}`,
        ``,
        `## What failed — fix exactly these`,
        ...failures(feedback.critique).map((v) => `- ${v.criterionId}: ${v.evidence}`),
      ]
    : [];

  return llm({
    system: [
      "You issue a build-vs-reuse triage verdict for a problem against a capability inventory",
      "(skill-forge triage discipline). Verdicts and thresholds:",
      "- use_existing: existing capabilities cover >=80% of the need. Build nothing.",
      "- improve_existing: an existing capability covers 50-79%; extend it.",
      "- compose: the need spans multiple existing capabilities combined across domains.",
      "- create_new: nothing existing reaches 50% coverage.",
      "The evidence must cite the specific inventory entries (by name) the verdict rests on,",
      "or state explicitly that the inventory contains no relevant capability.",
      "'Build nothing' is a valid, cheap outcome — do not invent work.",
    ].join("\n"),
    prompt: [
      `## Problem`,
      problem,
      ``,
      `## Capability inventory`,
      ...(inventory.length > 0 ? inventory.map(renderInventoryEntry) : ["(empty)"]),
      ...feedbackSection,
    ].join("\n"),
    schema: TriageVerdictSchema,
    schemaName: "triage_verdict",
  });
}

// ---------------------------------------------------------------------------
// (c) Constraint analysis, skeptic-vetted
// ---------------------------------------------------------------------------

async function elicitConstraint(
  llm: Llm,
  problem: string,
  inventory: InventoryEntry[],
  feedback: RefineFeedback<ConstraintAnalysis> | null
): Promise<ConstraintAnalysis> {
  const feedbackSection = feedback
    ? [
        ``,
        `## Previous constraint claim (REVISE — the skeptic broke it)`,
        feedback.previous.statement,
        ``,
        `## The skeptic's winning attack — your revised claim must survive this`,
        ...failures(feedback.critique).map((v) => `- ${v.evidence}`),
      ]
    : [];

  const raw = await llm({
    system: [
      "You perform a Theory-of-Constraints analysis of the process a problem implies.",
      "- flowSteps: the ordered steps of the flow the work moves through.",
      "- statement: the SINGLE constraint — the one step limiting throughput — as a falsifiable",
      "  claim, stated so that it COULD be wrong. Restating the problem is not a constraint.",
      "- type: policy | physical | knowledge | paradigm | market | material.",
      "- exploitOptions: squeeze more from the constraint without new investment.",
      "- subordinateOptions: subordinate non-constraint steps to the constraint's pace.",
      "- elevateOptions: investments that raise the constraint itself.",
      "- evidence: why THIS step is the constraint — grounded in the problem and the inventory,",
      "  not asserted.",
    ].join("\n"),
    prompt: [
      `## Problem`,
      problem,
      ``,
      `## Capability inventory (the environment the flow runs in)`,
      ...(inventory.length > 0 ? inventory.map(renderInventoryEntry) : ["(empty)"]),
      ...feedbackSection,
    ].join("\n"),
    schema: ConstraintAnalysisSchema,
    schemaName: "constraint_analysis",
  });

  return { id: "c1", ...raw };
}

/** Adapt a vetTruths outcome to a Critique so the constraint loop can reuse refine(). */
const vetCritique = (vet: VetResult): Critique => {
  if (vet.rejected.length > 0) {
    return { verdicts: [{ criterionId: "c-skeptic", pass: false, evidence: vet.rejected[0].attack }] };
  }
  return { verdicts: [{ criterionId: "c-skeptic", pass: true, evidence: "constraint claim survived the skeptic's attack" }] };
};

/** Render the classified inventory as skeptic observations — the scan is the
 * ground the skeptic attacks WITH (and may attack itself), reusing the existing
 * survey channel. Kind is display-only inside vetTruths' prompt; "topic-axis"
 * is the closest existing ObservationKind for capability-landscape facts. */
const inventoryObservations = (inventory: InventoryEntry[]): Observation[] =>
  inventory.map((e, i) => ({
    id: `inv${i + 1}`,
    kind: "topic-axis",
    statement: `capability ${e.name} (${e.kind}) is ${e.status}`,
    source: e.location || "inventory scan",
  }));

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export async function assess(llm: Llm, problem: string, opts: AssessOptions): Promise<AssessResult> {
  const fs = opts.fs ?? realFs;
  const notes: string[] = [];

  // (a) Deterministic scan — no LLM.
  const scan = scanRoots(fs, opts.roots);
  for (const root of scan.unavailableRoots) {
    notes.push(`inventory root unavailable, skipped: ${root}`);
  }

  const candidates = [...scan.candidates];
  let engramUnavailable = false;
  if (opts.engram) {
    try {
      const hits = await opts.engram.querySkills(problem);
      for (const hit of hits) {
        candidates.push({ name: hit.name, kind: "skill", location: hit.location ?? "engram-router", hint: "", source: "engram" });
      }
    } catch (e) {
      engramUnavailable = true;
      notes.push(`engram query failed (${(e as Error).message}) — recorded sentinel gap entry and continued`);
    }
  }

  // (b) LLM classification, then the judged triage verdict.
  const classified = await classifyInventory(llm, problem, candidates);
  const inventory: InventoryEntry[] = engramUnavailable ? [...classified, ENGRAM_SENTINEL] : classified;

  const triageContext = [
    `Problem: ${problem}`,
    `Inventory:`,
    ...(inventory.length > 0 ? inventory.map(renderInventoryEntry) : ["(empty)"]),
  ].join("\n");

  const triage = await refine<TriageVerdict>(
    (feedback) => elicitTriage(llm, problem, inventory, feedback),
    (candidate) =>
      judge(llm, {
        rubric: triageRubric,
        candidate: `verdict: ${candidate.verdict}\nevidence: ${candidate.evidence}`,
        context: triageContext,
      }),
    { maxIterations: 2 }
  );
  if (triage.status !== "converged") {
    const failed = failures(triage.history[triage.history.length - 1]).map((v) => v.criterionId);
    notes.push(`triage verdict did not converge (${triage.status}): failed criteria — ${failed.join(", ")}`);
  }

  // (c) Constraint analysis; the claim is vetted by the EXISTING skeptic
  // (truth_attack) with the inventory as its observation ground.
  const observations = inventoryObservations(inventory);
  let lastVet: VetResult | null = null;
  const constraint = await refine<ConstraintAnalysis>(
    (feedback) => elicitConstraint(llm, problem, inventory, feedback),
    async (candidate) => {
      const claim: Truth = { id: "c1", type: "constraint", statement: candidate.statement, rationale: candidate.evidence };
      lastVet = await vetTruths(llm, problem, [claim], observations);
      return vetCritique(lastVet);
    },
    { maxIterations: 2 }
  );
  if (constraint.status !== "converged") {
    const attack = lastVet && (lastVet as VetResult).rejected.length > 0 ? (lastVet as VetResult).rejected[0].attack : "(no attack recorded)";
    notes.push(`constraint claim did not survive skepticism: ${attack}`);
  } else if (lastVet && (lastVet as VetResult).assumptions.length > 0) {
    notes.push(`constraint claim demoted to assumption by skeptic — proceeding as if it holds`);
  }

  return {
    assessment: {
      triageVerdict: triage.result,
      inventory,
      constraint: constraint.result,
    },
    scannedRoots: scan.scannedRoots,
    unavailableRoots: scan.unavailableRoots,
    notes,
  };
}
