import { z } from "zod";
import { Llm } from "../llm/gateway";
import { Criterion, Critique, failures } from "../shared/types";
import { refine, RefineFeedback } from "../shared/refine";
import { judge } from "../shared/judge";
import { ProcessSpec } from "./types";

/**
 * IMPROVE — stage 8 of the process factory (design spec §4 [8], §5, §7 row 8):
 * measure-and-propose. The scan reads outcome records against a deployed
 * pack's decision rule and, when the evidence warrants it, proposes a spec
 * diff for the needs-review queue.
 *
 * Hard rules encoded here:
 *   - Minimum-sample rule (design §9): below the sample floor the scan refuses
 *     to propose — "don't improve through a broken measuring stick" — with
 *     ZERO LLM calls. Deterministic pre-checks always run before any model.
 *   - Improvement topology (design §5): a scan proposal may touch only the
 *     pack's single-loop surface (contract / knobs / artifacts). Structural
 *     change (foundations.truths, roles, meta, assessment) goes through
 *     re-compilation — the double loop — and the judge fails any diff that
 *     reaches for it (ip-scope).
 *   - Propose-only (D-044): NOTHING here applies a diff or writes a file. The
 *     module takes strings and data in and returns data out.
 *   - Invariant 5: a proposal whose judging never converged is returned with
 *     the escalation recorded in its evidence — surfaced, never blessed.
 *   - Invariant 1: no LLM request here ever sets webTools.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One outcome record from a deployed pack's sensory half: a CTQ observed over
 * a scan window, defect or not. Produced today by an offline dump file
 * (readOutcomes); an injected Engram API can produce the same shape later
 * (design §7 IMPROVE row — "dump file or Engram API; offline-friendly").
 */
export interface OutcomeRecord {
  packName: string;
  packVersion: string;
  /** CTQ id from the pack's contract (e.g. "ctq1"). */
  ctqId: string;
  /** The scan window the observation covers (e.g. "2026-W29"). */
  window: string;
  defect: boolean;
  evidence: string;
  /** ISO timestamp the record was written. */
  recordedAt: string;
}

/**
 * The factory registry file a deploy step writes (design §7 DEPLOY row:
 * engram-plugins/factory-registry.json, updated in the deployment PR). Kept
 * minimal: one entry per deployed pack version — the pack's marketplace
 * identity (name@version), the spec version it was emitted from, and where
 * its outcome records land.
 */
export interface RegistryFileEntry {
  /** Pack name (spec.meta.name). */
  name: string;
  /** Deployed pack version. */
  version: string;
  /** spec.meta.version the pack was emitted from. */
  specVersion: string;
  /** Where this deployment's outcome records land. */
  metricsLocation: string;
}

export interface RegistryFile {
  entries: RegistryFileEntry[];
}

/**
 * One proposed change to a spec. `path` is a dot path into the ProcessSpec
 * (e.g. "knobs.0.default", "contract.decisionRule"). LLM-produced entries
 * render `from`/`to` as strings (the structured-output schema has no unknown
 * type); the field is typed `unknown` so future non-LLM producers can carry
 * structured values.
 */
export interface SpecDiffEntry {
  path: string;
  from: unknown;
  to: unknown;
  rationale: string;
}

export interface ImprovementProposal {
  packName: string;
  /** The spec version the diff applies against (spec.meta.version). */
  targetSpecVersion: string;
  summary: string;
  specDiff: SpecDiffEntry[];
  evidence: string[];
  verdict: "propose" | "insufficient_data" | "healthy";
}

// ---------------------------------------------------------------------------
// readOutcomes — offline dump parsing (deterministic, no LLM)
// ---------------------------------------------------------------------------

const OutcomeRecordSchema = z
  .object({
    packName: z.string(),
    packVersion: z.string(),
    ctqId: z.string(),
    window: z.string(),
    defect: z.boolean(),
    evidence: z.string(),
    recordedAt: z.string(),
  })
  .strict();

/** A dump file is a JSON array of outcome records — nothing else. */
const OutcomeDumpSchema = z.array(OutcomeRecordSchema);

/**
 * Parse and validate an outcome-dump file's contents. Disk validation in the
 * loadSpec.ts style: strict objects (a record with unknown keys is a record
 * the scan would silently ignore parts of), every offending path listed —
 * never a bare "invalid". NEVER sent to an LLM.
 */
export function readOutcomes(json: string): OutcomeRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid outcome dump: not valid JSON — ${(e as Error).message}`);
  }
  const parsed = OutcomeDumpSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid outcome dump — shape validation failed:\n${issues}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// LLM schema (structured-output-safe: closed via zodToJsonSchema target
// "openAi", no numeric/string constraints, no recursion, no webTools ever)
// ---------------------------------------------------------------------------

export const ImprovementProposalSchema = z.object({
  summary: z.string(),
  specDiff: z.array(
    z.object({
      path: z.string(),
      from: z.string(),
      to: z.string(),
      rationale: z.string(),
    })
  ),
  evidence: z.array(z.string()),
});

type ProposalDraft = z.infer<typeof ImprovementProposalSchema>;

// ---------------------------------------------------------------------------
// Deterministic pre-checks (always before any LLM call)
// ---------------------------------------------------------------------------

/** Fallback sample floor when the spec declares no scanMinSampleSize knob. */
export const DEFAULT_MIN_SAMPLE = 20;

/** The knob name the seed spec declares for the minimum-sample rule. */
const MIN_SAMPLE_KNOB = "scanMinSampleSize";

/**
 * Resolve the sample floor: explicit option > the spec's own
 * scanMinSampleSize knob default (its declared single-loop surface) > 20.
 */
function resolveMinSample(spec: ProcessSpec, opts: { minSample?: number }): number {
  if (opts.minSample !== undefined) return opts.minSample;
  const knob = spec.knobs.find((k) => k.name === MIN_SAMPLE_KNOB);
  if (knob && typeof knob.default === "number") return knob.default;
  return DEFAULT_MIN_SAMPLE;
}

/**
 * Records relevant to a spec: packName matches spec.meta.name. Version
 * mismatches stay relevant — every deployed version of a pack shares the
 * spec lineage the proposal would revise.
 */
const relevantOutcomes = (spec: ProcessSpec, outcomes: OutcomeRecord[]): OutcomeRecord[] =>
  outcomes.filter((o) => o.packName === spec.meta.name);

// ---------------------------------------------------------------------------
// Rendering (shared between elicitation and judging so citations line up)
// ---------------------------------------------------------------------------

/** Stable labels ("r1", ...) over the defect records, for checkable citation. */
const renderDefectRecord = (o: OutcomeRecord, i: number): string =>
  `- [r${i + 1}] ${o.packName}@${o.packVersion} ctq=${o.ctqId} window=${o.window} — ${o.evidence} (recorded ${o.recordedAt})`;

const renderProposal = (p: ProposalDraft): string =>
  [
    `summary: ${p.summary}`,
    `specDiff:`,
    ...(p.specDiff.length
      ? p.specDiff.flatMap((d) => [
          `- path: ${d.path}`,
          `  from: ${d.from}`,
          `  to: ${d.to}`,
          `  rationale: ${d.rationale}`,
        ])
      : ["  (empty)"]),
    `evidence:`,
    ...(p.evidence.length ? p.evidence.map((e) => `- ${e}`) : ["  (empty)"]),
  ].join("\n");

const ALLOWED_SCOPE =
  "Allowed diff scope: paths under contract, knobs, or artifacts ONLY. " +
  "foundations (truths, subtasks), roles, meta, and assessment are structural — " +
  "structural change goes through re-compilation of the spec (double-loop), never a scan proposal.";

// ---------------------------------------------------------------------------
// Judged elicitation
// ---------------------------------------------------------------------------

/** Evidence-requiring rubric for improvement proposals (design §5, §7 row 8). */
export const improvementRubric: Criterion[] = [
  {
    id: "ip-evidence",
    description:
      "Every specDiff entry's rationale cites specific outcome records (by record label like r1, by window, or by recordedAt) that motivate that exact change. Generic appeals to 'the data' or 'the defects' fail.",
    source: "generic",
  },
  {
    id: "ip-scope",
    description:
      "Every specDiff path touches only contract, knobs, or artifacts fields of the spec. Any path into foundations (especially foundations.truths), roles, meta, or assessment fails — structural truth changes go through re-compilation, not a scan proposal.",
    source: "generic",
  },
];

async function elicitProposal(
  llm: Llm,
  spec: ProcessSpec,
  defects: OutcomeRecord[],
  sampleSize: number,
  feedback: RefineFeedback<ProposalDraft> | null
): Promise<ProposalDraft> {
  const feedbackSection = feedback
    ? [
        ``,
        `## Previous proposal (REVISE this — do not start over)`,
        renderProposal(feedback.previous),
        ``,
        `## What failed — fix exactly these`,
        ...failures(feedback.critique).map((v) => `- ${v.criterionId}: ${v.evidence}`),
      ]
    : [];

  return llm({
    system: [
      "You propose an improvement to a deployed process pack's spec, grounded in recorded outcome defects.",
      ALLOWED_SCOPE,
      "Each specDiff entry: `path` is a dot path into the spec (e.g. contract.decisionRule, knobs.0.default,",
      "artifacts.1.l2Rationale); `from` is the current value and `to` the proposed value, both rendered as",
      "strings; `rationale` must cite the specific defect records (by label, e.g. r1, r3) that motivate",
      "that exact change — unsupported changes are worthless.",
      "Propose the SMALLEST change the evidence supports. This proposal is never auto-applied: a human",
      "reviews it in the needs-review queue, so honesty beats ambition.",
    ].join("\n"),
    prompt: [
      `## Pack`,
      `${spec.meta.name} (spec version ${spec.meta.version})`,
      ``,
      `## Decision rule`,
      spec.contract.decisionRule,
      ``,
      `## CTQs`,
      ...spec.contract.ctqs.map((c) => `- ${c.id} (${c.persona}): ${c.metric} — defect: ${c.defectDefinition}`),
      ``,
      `## Declared knobs (the pack's legitimate single-loop surface)`,
      ...(spec.knobs.length
        ? spec.knobs.map(
            (k) => `- ${k.name}: ${k.purpose} (range: ${JSON.stringify(k.range)}, default: ${k.default})`
          )
        : ["(none)"]),
      ``,
      `## Artifacts`,
      ...(spec.artifacts.length
        ? spec.artifacts.map((a) => `- ${a.name} [${a.kind}, ${a.disposition}]`)
        : ["(none)"]),
      ``,
      `## Defect records (${defects.length} defects among ${sampleSize} relevant outcome records)`,
      ...defects.map(renderDefectRecord),
      ...feedbackSection,
    ].join("\n"),
    schema: ImprovementProposalSchema,
    schemaName: "improvement_proposal",
  });
}

// ---------------------------------------------------------------------------
// scanPack — deterministic pre-checks, then measure-and-propose
// ---------------------------------------------------------------------------

/**
 * Scan one pack's outcomes against its spec. Deterministic pre-checks run
 * FIRST and short-circuit with zero LLM calls:
 *
 *   (a) fewer relevant records than the sample floor → "insufficient_data"
 *       (minimum-sample rule, design §9);
 *   (b) no defect records → "healthy" — the decision rule's trigger is defect
 *       presence (the seed's "if any CTQ records a defect" pattern; the full
 *       decisionRule text travels to the LLM and judge as context, it is not
 *       parsed).
 *
 * Only with the sample floor met AND defects present does the LLM propose a
 * spec diff (`improvement_proposal`), judged by the evidence-requiring rubric
 * inside a refine loop (maxIterations 2). Non-convergence keeps the verdict
 * "propose" but records the escalation in the proposal's evidence — surfaced,
 * never silently blessed. Proposals are NEVER applied: no file writes here.
 */
export async function scanPack(
  llm: Llm,
  spec: ProcessSpec,
  outcomes: OutcomeRecord[],
  opts: { minSample?: number } = {}
): Promise<ImprovementProposal> {
  const minSample = resolveMinSample(spec, opts);
  const relevant = relevantOutcomes(spec, outcomes);
  const base = { packName: spec.meta.name, targetSpecVersion: spec.meta.version };

  // (a) Minimum-sample rule — don't improve through a broken measuring stick.
  if (relevant.length < minSample) {
    return {
      ...base,
      summary: `Insufficient data: ${relevant.length} relevant outcome records < minimum sample ${minSample} — refusing to propose from noise.`,
      specDiff: [],
      evidence: [
        `minimum-sample rule (design §9): ${relevant.length} records for pack "${spec.meta.name}" is below the floor of ${minSample}; no LLM was consulted`,
      ],
      verdict: "insufficient_data",
    };
  }

  // (b) No defects → healthy; the decision rule has nothing to trigger on.
  const defects = relevant.filter((o) => o.defect);
  if (defects.length === 0) {
    return {
      ...base,
      summary: `Healthy: 0 defects among ${relevant.length} relevant outcome records — decision rule not triggered.`,
      specDiff: [],
      evidence: [
        `${relevant.length} relevant outcome records, all defect-free against decision rule: ${spec.contract.decisionRule}`,
      ],
      verdict: "healthy",
    };
  }

  // Defects present at sufficient sample: propose, judged.
  const judgeContext = [
    `Pack: ${spec.meta.name} (spec version ${spec.meta.version})`,
    `Decision rule: ${spec.contract.decisionRule}`,
    ALLOWED_SCOPE,
    `Defect records:`,
    ...defects.map(renderDefectRecord),
  ].join("\n");

  const outcome = await refine<ProposalDraft>(
    (feedback) => elicitProposal(llm, spec, defects, relevant.length, feedback),
    (candidate) =>
      judge(llm, {
        rubric: improvementRubric,
        candidate: renderProposal(candidate),
        context: judgeContext,
      }),
    { maxIterations: 2 }
  );

  const evidence = [...outcome.result.evidence];
  if (outcome.status !== "converged") {
    const failed = failures(outcome.history[outcome.history.length - 1]);
    evidence.push(
      `ESCALATION: improvement proposal did not converge (${outcome.status}) — failed criteria: ` +
        failed.map((v) => `${v.criterionId} (${v.evidence})`).join("; ") +
        `. Surfaced for operator review, not blessed.`
    );
  }

  return {
    ...base,
    summary: outcome.result.summary,
    specDiff: outcome.result.specDiff,
    evidence,
    verdict: "propose",
  };
}

// ---------------------------------------------------------------------------
// scanPortfolio — per-pack scans + deterministic cross-pack Pareto
// ---------------------------------------------------------------------------

/**
 * Scan every pack, then run a DETERMINISTIC Pareto pass (no LLM) across the
 * portfolio's defects (design §5 portfolio learning): each entry's outcomes
 * are first filtered to that entry's pack (so passing one combined dump to
 * every entry cannot double-count), defect records are pooled and grouped by
 * ctqId — the cross-pack "shape" of a failure, since factory-templated CTQs
 * share ids across packs. If one ctqId accounts for >50% of all defects AND
 * spans >=2 distinct packs, that is a candidate factory-template issue, not a
 * per-pack one, and a portfolioNote names it. Distributed self-improvers are
 * blind to each other; this pass is where the central engine compounds.
 */
export async function scanPortfolio(
  llm: Llm,
  entries: { spec: ProcessSpec; outcomes: OutcomeRecord[] }[],
  opts: { minSample?: number } = {}
): Promise<{ perPack: ImprovementProposal[]; portfolioNotes: string[] }> {
  const perPack: ImprovementProposal[] = [];
  for (const entry of entries) {
    perPack.push(await scanPack(llm, entry.spec, entry.outcomes, opts));
  }

  const pooledDefects = entries.flatMap((e) =>
    relevantOutcomes(e.spec, e.outcomes).filter((o) => o.defect)
  );
  const portfolioNotes: string[] = [];
  const byCtq = new Map<string, OutcomeRecord[]>();
  for (const d of pooledDefects) {
    const group = byCtq.get(d.ctqId) ?? [];
    group.push(d);
    byCtq.set(d.ctqId, group);
  }
  for (const [ctqId, group] of byCtq) {
    const packs = [...new Set(group.map((d) => d.packName))];
    if (group.length * 2 > pooledDefects.length && packs.length >= 2) {
      portfolioNotes.push(
        `portfolio Pareto: ctqId "${ctqId}" accounts for ${group.length} of ${pooledDefects.length} defect records ` +
          `across ${packs.length} packs (${packs.join(", ")}) — candidate factory-template issue; ` +
          `the fix belongs in the factory's own templates/stages, not any single pack (design §5 portfolio learning)`
      );
    }
  }

  return { perPack, portfolioNotes };
}

// ---------------------------------------------------------------------------
// checkRegistryDrift — deterministic registry-vs-marketplace cross-check
// ---------------------------------------------------------------------------

/**
 * Cross-check the registry against a marketplace listing (design §10
 * registry-drift row). `marketplaceListing` items are "name@version" strings;
 * registry entries are keyed the same way. Both directions drift: a registry
 * entry absent from the marketplace, and a marketplace pack absent from the
 * registry. Deterministic — no LLM.
 */
export function checkRegistryDrift(registry: RegistryFile, marketplaceListing: string[]): string[] {
  const notes: string[] = [];
  const registryKeys = new Set(registry.entries.map((e) => `${e.name}@${e.version}`));
  const listingKeys = new Set(marketplaceListing);

  for (const entry of registry.entries) {
    const key = `${entry.name}@${entry.version}`;
    if (!listingKeys.has(key)) {
      notes.push(`registry drift: ${key} is in the registry but not in the marketplace listing`);
    }
  }
  for (const item of marketplaceListing) {
    if (!registryKeys.has(item)) {
      notes.push(`registry drift: ${item} is in the marketplace listing but not in the registry`);
    }
  }
  return notes;
}
