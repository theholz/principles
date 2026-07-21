import { Critique } from "../shared/types";
import { Artifact, ArtifactRelationships, Ctq, Knob, ProcessSpec, Role } from "./types";

/**
 * Mechanical (no-LLM) validators over a ProcessSpec — the first tier of the
 * design's two-tier validation (2026-07-20-process-factory-design.md §6).
 * House style follows src/core/coverage.ts: pure functions → offender lists →
 * Critique. Free and deterministic — always run before any LLM judge.
 */

// --- pv-traceability -------------------------------------------------------

/** An artifact citing no truth and no constraint is an orphan. Orphan = cut. */
export function orphanArtifacts(artifacts: Artifact[]): string[] {
  return artifacts
    .filter((a) => a.traceability.truthIds.length + a.traceability.constraintIds.length === 0)
    .map((a) => a.name);
}

/**
 * Citations that resolve to nothing. Truth ids may name truths or assumptions
 * (the process proceeds as if assumptions hold) — never rejected truths, the
 * skeptic broke those. Constraint ids must name the constraint analysis.
 */
export function danglingTraceability(spec: ProcessSpec): string[] {
  const knownTruths = new Set(
    [...spec.foundations.truths, ...spec.foundations.assumptions].map((t) => t.id),
  );
  const knownConstraints = new Set([spec.assessment.constraint.id]);
  return spec.artifacts.flatMap((a) => [
    ...a.traceability.truthIds.filter((id) => !knownTruths.has(id)).map((id) => `${a.name}→${id}`),
    ...a.traceability.constraintIds
      .filter((id) => !knownConstraints.has(id))
      .map((id) => `${a.name}→${id}`),
  ]);
}

// --- pv-contract-complete --------------------------------------------------

/** A role with no CTQ slice is accountable for nothing measurable. */
export function rolesWithoutCtqs(roles: Role[]): string[] {
  return roles.filter((r) => r.ctqIds.length === 0).map((r) => r.id);
}

/** Role CTQ citations that name no CTQ in the contract. */
export function unknownCtqCitations(roles: Role[], ctqs: Ctq[]): string[] {
  const known = new Set(ctqs.map((c) => c.id));
  return roles.flatMap((r) =>
    r.ctqIds.filter((id) => !known.has(id)).map((id) => `${r.id}→${id}`),
  );
}

/** A CTQ without a defect definition can never record a defect — unfalsifiable. */
export function undefinedDefects(ctqs: Ctq[]): string[] {
  return ctqs.filter((c) => c.defectDefinition.trim() === "").map((c) => c.id);
}

// --- pv-forge-relationships ------------------------------------------------

const RELATIONSHIP_KEYS: (keyof ArtifactRelationships)[] = [
  "dependsOn",
  "complements",
  "composesWith",
  "supersedes",
  "bindsTools",
];

/** bindsTools names tools, not artifacts — exempt from name resolution. */
const ARTIFACT_REF_KEYS: (keyof ArtifactRelationships)[] = [
  "dependsOn",
  "complements",
  "composesWith",
  "supersedes",
];

/**
 * A forge_new artifact is a handoff to skill-forge: it must arrive with a
 * non-empty name and all five relationship arrays present. The type system
 * guarantees this for compiled specs; specs assembled from LLM output or
 * hand-edited JSON do not get that guarantee, so the check is runtime.
 */
export function malformedForgeArtifacts(artifacts: Artifact[]): string[] {
  return artifacts
    .filter((a) => a.disposition === "forge_new")
    .filter((a) => {
      const rel = a.relationships as Partial<ArtifactRelationships> | undefined;
      const arraysPresent = rel !== undefined && RELATIONSHIP_KEYS.every((k) => Array.isArray(rel[k]));
      return a.name.trim() === "" || !arraysPresent;
    })
    .map((a) => (a.name.trim() === "" ? "(unnamed forge_new artifact)" : a.name));
}

/**
 * Relationship entries naming artifacts that don't exist in the spec —
 * checked on ALL artifacts regardless of disposition: a reuse_existing entry
 * complementing a phantom is just as broken a plan.
 */
export function danglingRelationships(artifacts: Artifact[]): string[] {
  const known = new Set(artifacts.map((a) => a.name));
  return artifacts.flatMap((a) => {
    const rel = a.relationships as Partial<ArtifactRelationships> | undefined;
    return ARTIFACT_REF_KEYS.flatMap((k) =>
      (rel?.[k] ?? []).filter((name) => !known.has(name)).map((name) => `${a.name}→${name}`),
    );
  });
}

// --- pv-knob-bounds --------------------------------------------------------

/**
 * KnobRange well-formedness lives here, never in a schema (invariant 4 forbids
 * numeric/string schema constraints): numeric ranges need min < max and a
 * numeric default inside [min, max]; enum ranges need a string default drawn
 * from the allowed values. The !(min < max) form also catches NaN bounds.
 */
export function malformedKnobs(knobs: Knob[]): string[] {
  return knobs
    .filter((k) => {
      if (Array.isArray(k.range)) {
        return typeof k.default !== "string" || !k.range.includes(k.default);
      }
      return (
        !(k.range.min < k.range.max) ||
        typeof k.default !== "number" ||
        k.default < k.range.min ||
        k.default > k.range.max
      );
    })
    .map((k) => k.name);
}

// --- aggregator ------------------------------------------------------------

const verdict = (criterionId: string, offenders: string[], passMsg: string) => ({
  criterionId,
  pass: offenders.length === 0,
  evidence: offenders.length === 0 ? passMsg : `Offending ids: ${offenders.join(", ")}`,
});

/**
 * Mechanical critique of a full ProcessSpec. An orphan artifact is an
 * unjustified intervention; a role without a CTQ is unaccountable; a
 * forge_new entry without relationships is an unusable handoff; a knob whose
 * default escapes its range is a lie about the tuning surface.
 */
export function validateProcessSpec(spec: ProcessSpec): Critique {
  return {
    verdicts: [
      verdict(
        "pv-traceability",
        [...orphanArtifacts(spec.artifacts), ...danglingTraceability(spec)],
        "every artifact cites at least one resolvable truth or constraint",
      ),
      verdict(
        "pv-contract-complete",
        [
          ...(spec.contract.decisionRule.trim() === "" ? ["(empty decisionRule)"] : []),
          ...undefinedDefects(spec.contract.ctqs),
          ...rolesWithoutCtqs(spec.roles),
          ...unknownCtqCitations(spec.roles, spec.contract.ctqs),
        ],
        "every role carries a resolvable CTQ slice, every CTQ defines its defect, and a decision rule exists",
      ),
      verdict(
        "pv-forge-relationships",
        [...malformedForgeArtifacts(spec.artifacts), ...danglingRelationships(spec.artifacts)],
        "every forge_new artifact is a complete handoff and all relationship names resolve",
      ),
      verdict(
        "pv-knob-bounds",
        malformedKnobs(spec.knobs),
        "every knob default sits inside a well-formed range",
      ),
    ],
  };
}
