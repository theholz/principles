import { z } from "zod";
import { ProcessSpec } from "./types";

/**
 * Disk validation for process-spec.json files. NEVER sent to an LLM — the
 * factory's LLM schemas live inline in their calling stages (assess.ts,
 * contract.ts, ...). Kept strict (closed objects) anyway: a spec file with
 * unknown keys is a spec file the emitter would silently ignore parts of.
 *
 * The schemas mirror src/factory/types.ts (which imports the core types from
 * src/shared/types.ts unchanged); the ZodType<ProcessSpec> annotation makes
 * tsc fail if the two drift apart.
 */

// --- shared core types (mirrored for validation; TS types stay imported) ---

const TruthSchema = z
  .object({
    id: z.string(),
    type: z.enum(["fact", "assumption", "constraint", "definition"]),
    statement: z.string(),
    rationale: z.string(),
    groundedIn: z.array(z.string()).optional(),
  })
  .strict();

const ObservationSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["genre-convention", "topic-axis"]),
    statement: z.string(),
    source: z.string(),
  })
  .strict();

const SubtaskSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    servesTruths: z.array(z.string()),
    dependsOn: z.array(z.string()),
    needsWeb: z.boolean().optional(),
    webJustification: z.string().optional(),
  })
  .strict();

const CoverageMapRowSchema = z
  .object({
    dimension: z.string(),
    handledBy: z.string(),
    exclusionReason: z.string(),
  })
  .strict();

// --- factory blocks ---

const LineageSchema = z
  .object({
    parentVersion: z.string().nullable(),
    improvementProposals: z.array(z.string()),
  })
  .strict();

const MetaSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    problemStatement: z.string(),
    domain: z.string(),
    scalingTier: z.enum(["trivial", "simple", "medium", "complex"]),
    lineage: LineageSchema,
  })
  .strict();

const TriageVerdictSchema = z
  .object({
    verdict: z.enum(["use_existing", "improve_existing", "compose", "create_new"]),
    evidence: z.string(),
  })
  .strict();

const InventoryEntrySchema = z
  .object({
    name: z.string(),
    kind: z.string(),
    location: z.string(),
    status: z.enum(["built", "partial", "gap"]),
  })
  .strict();

const ConstraintAnalysisSchema = z
  .object({
    id: z.string(),
    flowSteps: z.array(z.string()),
    statement: z.string(),
    type: z.enum(["policy", "physical", "knowledge", "paradigm", "market", "material"]),
    exploitOptions: z.array(z.string()),
    subordinateOptions: z.array(z.string()),
    elevateOptions: z.array(z.string()),
    evidence: z.string(),
  })
  .strict();

const AssessmentSchema = z
  .object({
    triageVerdict: TriageVerdictSchema,
    inventory: z.array(InventoryEntrySchema),
    constraint: ConstraintAnalysisSchema,
  })
  .strict();

const FoundationsSchema = z
  .object({
    truths: z.array(TruthSchema),
    assumptions: z.array(TruthSchema),
    rejected: z.array(z.object({ truth: TruthSchema, attack: z.string() }).strict()),
    subtasks: z.array(SubtaskSchema),
    coverageMap: z.array(CoverageMapRowSchema),
    survey: z.array(ObservationSchema),
  })
  .strict();

const CtqSchema = z
  .object({
    id: z.string(),
    persona: z.string(),
    metric: z.string(),
    specLimit: z.string(),
    defectDefinition: z.string(),
  })
  .strict();

const ContractSchema = z
  .object({
    ctqs: z.array(CtqSchema),
    baseline: z.string(),
    decisionRule: z.string(),
    controlPlan: z.object({ monitoringCadence: z.string(), response: z.string() }).strict(),
    governancePhase: z.enum(["shadow", "advisory", "enforcement"]),
  })
  .strict();

const RoleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    subtaskId: z.string(),
    instructions: z.string(),
    servesTruths: z.array(z.string()),
    dependsOn: z.array(z.string()),
    outputHint: z.string(),
    webTools: z.boolean().optional(),
    ctqIds: z.array(z.string()),
  })
  .strict();

const ArtifactSchema = z
  .object({
    name: z.string(),
    kind: z.enum(["skill", "hook", "gate", "agent", "command", "config"]),
    disposition: z.enum(["reuse_existing", "forge_new", "generate"]),
    traceability: z
      .object({
        truthIds: z.array(z.string()),
        constraintIds: z.array(z.string()),
      })
      .strict(),
    l2Rationale: z.string(),
    relationships: z
      .object({
        dependsOn: z.array(z.string()),
        complements: z.array(z.string()),
        composesWith: z.array(z.string()),
        supersedes: z.array(z.string()),
        bindsTools: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

// Plain numbers / plain strings only — well-formedness (min < max, default in
// range) is Task 2's mechanical validator, never a schema constraint.
const KnobRangeSchema = z.union([
  z.object({ min: z.number(), max: z.number() }).strict(),
  z.array(z.string()),
]);

const KnobSchema = z
  .object({
    name: z.string(),
    purpose: z.string(),
    range: KnobRangeSchema,
    default: z.union([z.number(), z.string()]),
  })
  .strict();

const RegistryEntrySchema = z
  .object({
    targets: z.array(z.string()),
    versions: z.array(z.string()),
    metricsLocations: z.array(z.string()),
  })
  .strict();

export const ProcessSpecSchema: z.ZodType<ProcessSpec> = z
  .object({
    meta: MetaSchema,
    assessment: AssessmentSchema,
    foundations: FoundationsSchema,
    contract: ContractSchema,
    roles: z.array(RoleSchema),
    artifacts: z.array(ArtifactSchema),
    knobs: z.array(KnobSchema),
    methodologyDeps: z.array(z.string()),
    registryEntry: RegistryEntrySchema,
  })
  .strict();

/**
 * Parse and shape-validate a process-spec.json string. Throws with every
 * offending path listed — never a bare "invalid". Semantic validation
 * (traceability resolves, knob bounds well-formed, ...) is validators.ts's
 * job, not the loader's.
 */
export function loadProcessSpec(json: string): ProcessSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid process spec: not valid JSON — ${(e as Error).message}`);
  }
  const parsed = ProcessSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid process spec — shape validation failed:\n${issues}`);
  }
  return parsed.data;
}
