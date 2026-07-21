import { Truth, Subtask, CoverageMapRow, Observation, AgentSpec } from "../shared/types";

/**
 * ProcessSpec — the runtime-neutral output of the process factory
 * (design: docs/superpowers/specs/2026-07-20-process-factory-design.md §6).
 *
 * Extends what ontology.json already is: the foundations block embeds the
 * EXISTING principles-core types unchanged (the provenance root), and the
 * factory-specific blocks (assessment, contract, artifacts, knobs) wrap them.
 * Pure data — no code, exactly like Ontology.
 */

export type ScalingTier = "trivial" | "simple" | "medium" | "complex";

/** Parent spec version + which improvement proposals produced this revision. */
export interface Lineage {
  /** null for a v0 / hand-authored seed with no parent. */
  parentVersion: string | null;
  improvementProposals: string[];
}

export interface ProcessMeta {
  name: string;
  version: string;
  /** One sentence. */
  problemStatement: string;
  domain: string;
  scalingTier: ScalingTier;
  lineage: Lineage;
}

// ---------------------------------------------------------------------------
// Assessment (stage 1: feature-framework inventory + forge triage + TOC)
// ---------------------------------------------------------------------------

export type TriageVerdictKind = "use_existing" | "improve_existing" | "compose" | "create_new";

export interface TriageVerdict {
  verdict: TriageVerdictKind;
  evidence: string;
}

export type InventoryStatus = "built" | "partial" | "gap";

/** An existing (or missing) capability found by the inventory scan. */
export interface InventoryEntry {
  name: string;
  /** Free-form: "skill", "plugin", "pipeline", "service", ... — not the artifact kind enum. */
  kind: string;
  /** Where it lives; empty for a pure gap. */
  location: string;
  status: InventoryStatus;
}

export type ConstraintType = "policy" | "physical" | "knowledge" | "paradigm" | "market" | "material";

/** Theory-of-Constraints analysis: the one limiting step and the Five Focusing Steps around it. */
export interface ConstraintAnalysis {
  /** "c1", ... — cited by artifact traceability. */
  id: string;
  /** Ordered steps of the flow the constraint sits in. */
  flowSteps: string[];
  /** The constraint itself, as a falsifiable statement. */
  statement: string;
  type: ConstraintType;
  exploitOptions: string[];
  subordinateOptions: string[];
  elevateOptions: string[];
  evidence: string;
}

export interface Assessment {
  triageVerdict: TriageVerdict;
  inventory: InventoryEntry[];
  constraint: ConstraintAnalysis;
}

// ---------------------------------------------------------------------------
// Foundations (stage 2: UNCHANGED principles core output — the provenance root)
// ---------------------------------------------------------------------------

/**
 * Serialized principles-core output. Every field type here is imported from
 * src/shared/types.ts unchanged — the factory never redefines the core types.
 * (Named ProcessFoundations to avoid colliding with src/core/foundations.ts's
 * in-flight Foundations, which additionally carries refine-loop state.)
 */
export interface ProcessFoundations {
  /** Skeptic survivals. */
  truths: Truth[];
  /** Demoted truths — the process proceeds as if these hold. */
  assumptions: Truth[];
  /** Truths the skeptic broke, with the winning attack recorded. */
  rejected: { truth: Truth; attack: string }[];
  subtasks: Subtask[];
  coverageMap: CoverageMapRow[];
  /** Landscape survey observations that grounded truth derivation (empty when skipped). */
  survey: Observation[];
}

// ---------------------------------------------------------------------------
// Contract (stage 3: DMAIC Define/Measure)
// ---------------------------------------------------------------------------

/** Critical-to-quality metric: persona → metric → spec limit → defect definition. */
export interface Ctq {
  /** "ctq1", ... — referenced by Role.ctqIds. */
  id: string;
  persona: string;
  metric: string;
  specLimit: string;
  defectDefinition: string;
}

export interface ControlPlan {
  monitoringCadence: string;
  response: string;
}

export type GovernancePhase = "shadow" | "advisory" | "enforcement";

export interface Contract {
  ctqs: Ctq[];
  /** A real measured value, or the honest literal "unmeasured" — never an invented number. */
  baseline: string;
  decisionRule: string;
  controlPlan: ControlPlan;
  /** Always "shadow" at birth. */
  governancePhase: GovernancePhase;
}

// ---------------------------------------------------------------------------
// Roles, artifacts, knobs
// ---------------------------------------------------------------------------

/** A truth-citing agent spec (existing core type, unchanged) carrying its CTQ slice. */
export interface Role extends AgentSpec {
  /** Ids of the contract CTQs this role is accountable for. */
  ctqIds: string[];
}

export type ArtifactKind = "skill" | "hook" | "gate" | "agent" | "command" | "config";

export type ArtifactDisposition = "reuse_existing" | "forge_new" | "generate";

/** Which truths / constraints justify this artifact's existence. Orphan = cut. */
export interface Traceability {
  truthIds: string[];
  constraintIds: string[];
}

export interface ArtifactRelationships {
  dependsOn: string[];
  complements: string[];
  composesWith: string[];
  supersedes: string[];
  bindsTools: string[];
}

/** One entry per needed capability. */
export interface Artifact {
  name: string;
  kind: ArtifactKind;
  disposition: ArtifactDisposition;
  traceability: Traceability;
  /** Why this intervention type (L2 routing table rationale). */
  l2Rationale: string;
  relationships: ArtifactRelationships;
}

/**
 * Allowed range for a declared tunable: plain min–max numbers, or the enum of
 * allowed strings. Kept as plain fields — range well-formedness (min < max,
 * default in range) is a mechanical validator's job, never a schema constraint.
 */
export type KnobRange = { min: number; max: number } | string[];

/** A declared tunable — the pack's legitimate single-loop improvement surface. */
export interface Knob {
  name: string;
  purpose: string;
  range: KnobRange;
  default: number | string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  /** Deployment targets (e.g. engram-plugins paths). Empty before first deploy. */
  targets: string[];
  /** Deployed versions. Empty before first deploy. */
  versions: string[];
  /** Where this process's outcome metrics land. Empty before first deploy. */
  metricsLocations: string[];
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

export interface ProcessSpec {
  meta: ProcessMeta;
  assessment: Assessment;
  foundations: ProcessFoundations;
  contract: Contract;
  roles: Role[];
  artifacts: Artifact[];
  knobs: Knob[];
  methodologyDeps: string[];
  registryEntry: RegistryEntry;
}
