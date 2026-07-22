import realFs from "fs-extra";
import path from "path";
import { Truth } from "../../shared/types";
import { Artifact, ProcessSpec, Role } from "../types";

/**
 * Process-pack emitter: pure deterministic templating from a ProcessSpec to a
 * Claude Code plugin directory (design §7 EMIT row). NO LLM, NO network — the
 * emitted text is a mechanical function of the spec, so it cannot lie about
 * provenance. Layout copied from real installed plugins
 * (~/.claude/plugins/cache/engram-plugins/{methodologies,skill-forge}/0.1.0/):
 *
 *   .claude-plugin/plugin.json        manifest (real installed-plugin format)
 *   skills/<name>/SKILL.md            kind=skill, disposition=generate
 *   hooks/<name>.md                   kind=hook  — spec stubs (generate: not live
 *   gates/<name>.md                   kind=gate    code; reuse_existing: reference
 *                                                  to live machinery that governs)
 *   manifest/metrics.json             pack-level sensory half (design §5)
 *   manifest/forge-handoff.json       disposition=forge_new → skill-forge
 *   process-spec.json                 the input spec verbatim (provenance)
 *
 * Atomicity (design §9): every file is rendered in memory first — any
 * templating failure is a hard throw before a single byte lands on disk —
 * then written to a temp sibling directory and renamed into place. A partial
 * pack can never exist at outDir; an existing outDir is refused.
 *
 * Sibling of src/core/emit.ts (invariant 3): the TS-package emit path is
 * untouched, and nothing here reaches into src/shared|llm|runtime.
 */

/** Minimal fs surface, injectable for tests. fs-extra satisfies it. */
export interface EmitFs {
  existsSync(p: string): boolean;
  ensureDirSync(p: string): void;
  writeFileSync(p: string, data: string): void;
  renameSync(from: string, to: string): void;
  removeSync(p: string): void;
}

export interface EmitDeps {
  fs?: EmitFs;
}

export function emitProcessPack(spec: ProcessSpec, outDir: string, deps: EmitDeps = {}): string {
  const fs = deps.fs ?? realFs;
  if (fs.existsSync(outDir)) {
    throw new Error(`Refusing to emit: output directory already exists — ${outDir}`);
  }

  // Render everything first: templating failures throw before any write.
  const files = renderPack(spec);

  const tmpDir = path.join(
    path.dirname(outDir),
    `.${path.basename(outDir)}.tmp-${process.pid}-${Date.now()}`
  );
  try {
    for (const [rel, content] of files) {
      const abs = path.join(tmpDir, rel);
      fs.ensureDirSync(path.dirname(abs));
      fs.writeFileSync(abs, content);
    }
    fs.renameSync(tmpDir, outDir);
  } catch (e) {
    // Best-effort cleanup: a removeSync failure must never mask the original
    // templating/write error being rethrown below.
    try {
      fs.removeSync(tmpDir);
    } catch {
      /* swallowed deliberately — the original error propagates */
    }
    throw e;
  }
  return outDir;
}

// ---------------------------------------------------------------------------
// Rendering — pure functions of the spec, deterministic by construction
// ---------------------------------------------------------------------------

/** Ordered [relativePath, content] pairs; throws on any templating problem. */
export function renderPack(spec: ProcessSpec): [string, string][] {
  const files: [string, string][] = [];
  const seen = new Set<string>();
  const add = (rel: string, content: string) => {
    if (seen.has(rel)) {
      throw new Error(`Templating failure: duplicate emitted path "${rel}" — artifact names must be unique per kind`);
    }
    seen.add(rel);
    files.push([rel, content]);
  };

  add(path.join(".claude-plugin", "plugin.json"), renderManifest(spec));

  for (const artifact of spec.artifacts) {
    if (artifact.kind === "skill" && artifact.disposition === "generate") {
      add(path.join("skills", safeName(artifact), "SKILL.md"), renderSkillMd(spec, artifact));
    } else if (artifact.kind === "hook") {
      add(path.join("hooks", `${safeName(artifact)}.md`), renderStubMd(spec, artifact));
    } else if (artifact.kind === "gate") {
      add(path.join("gates", `${safeName(artifact)}.md`), renderStubMd(spec, artifact));
    } else if (artifact.disposition === "generate") {
      // agent/command/config generation is a later factory task; silently
      // dropping a generate-disposition artifact would bless an unemitted
      // capability (invariant 5), so refuse loudly instead.
      throw new Error(
        `Templating failure: artifact "${artifact.name}" has kind "${artifact.kind}" with disposition "generate" — ` +
          `not yet supported by the process-pack emitter (a later task adds it); refusing to silently drop it`
      );
    }
    // reuse_existing / forge_new skills produce no files here: they live in
    // the embedded spec and (for forge_new) in manifest/forge-handoff.json.
  }

  add(path.join("manifest", "metrics.json"), renderMetricsManifest(spec));
  add(path.join("manifest", "forge-handoff.json"), renderForgeHandoff(spec));
  add("process-spec.json", jsonFile(spec));

  return files;
}

const jsonFile = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

/** A YAML double-quoted scalar. JSON string escaping is valid YAML escaping. */
const yq = (s: string): string => JSON.stringify(s);
const yList = (xs: string[]): string => `[${xs.map(yq).join(", ")}]`;

const bulletsOrNone = (xs: string[]): string[] => (xs.length ? xs.map((x) => `- ${x}`) : ["- (none)"]);

function safeName(artifact: Artifact): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(artifact.name)) {
    throw new Error(
      `Templating failure: artifact name ${JSON.stringify(artifact.name)} is not filesystem-safe ` +
        `(expected /^[A-Za-z0-9][A-Za-z0-9_-]*$/)`
    );
  }
  return artifact.name;
}

/** Resolve cited truth ids to Truths (searching truths + assumptions) or throw. */
function tracedTruths(spec: ProcessSpec, artifact: Artifact): Truth[] {
  const pool = [...spec.foundations.truths, ...spec.foundations.assumptions];
  return artifact.traceability.truthIds.map((id) => {
    const truth = pool.find((t) => t.id === id);
    if (!truth) {
      throw new Error(
        `Templating failure: artifact "${artifact.name}" cites unknown truth id "${id}" — refusing to emit unverifiable provenance`
      );
    }
    return truth;
  });
}

/** Resolve cited constraint ids against the assessment's constraint or throw. */
function tracedConstraintIds(spec: ProcessSpec, artifact: Artifact): string[] {
  for (const id of artifact.traceability.constraintIds) {
    if (id !== spec.assessment.constraint.id) {
      throw new Error(
        `Templating failure: artifact "${artifact.name}" cites unknown constraint id "${id}" — refusing to emit unverifiable provenance`
      );
    }
  }
  return artifact.traceability.constraintIds;
}

// --- .claude-plugin/plugin.json --------------------------------------------

/**
 * Real installed-plugin manifest format (verified against
 * engram-plugins methodologies + skill-forge caches). Author/homepage/license
 * are deliberately omitted: the spec does not carry them and the emitter never
 * invents facts. All fields below map 1:1 from the spec.
 */
function renderManifest(spec: ProcessSpec): string {
  return jsonFile({
    name: spec.meta.name,
    description: spec.meta.problemStatement,
    version: spec.meta.version,
    keywords: [spec.meta.domain, ...spec.methodologyDeps],
    category: "process-pack",
    domain: spec.meta.domain,
  });
}

// --- skills/<name>/SKILL.md ------------------------------------------------

function renderSkillMd(spec: ProcessSpec, artifact: Artifact): string {
  const truths = tracedTruths(spec, artifact);
  const constraintIds = tracedConstraintIds(spec, artifact);
  const roles = spec.roles.filter((r) =>
    r.servesTruths.some((id) => artifact.traceability.truthIds.includes(id))
  );

  // Short purpose blurb only (PR #21 review): truth quotations live in the
  // body's provenance section, never in the routing-facing description.
  const description = artifact.l2Rationale;

  const frontmatter = [
    "---",
    `name: ${yq(artifact.name)}`,
    `description: ${yq(description)}`,
    `version: ${yq(spec.meta.version)}`,
    `depends_on: ${yList(artifact.relationships.dependsOn)}`,
    `complements: ${yList(artifact.relationships.complements)}`,
    `composes_with: ${yList(artifact.relationships.composesWith)}`,
    `supersedes: ${yList(artifact.relationships.supersedes)}`,
    `binds_tools: ${yList(artifact.relationships.bindsTools)}`,
    "metadata:",
    "  metrics:",
    `    prometheus_prefix: ${yq(`skill_${artifact.name.replace(/-/g, "_")}_`)}`,
    `    langfuse_tag: ${yq(`skill.${artifact.name}.v${spec.meta.version}`)}`,
    `    governance_phase: ${yq(spec.contract.governancePhase)}`,
    `    decision_rule: ${yq(spec.contract.decisionRule)}`,
    `    baseline: ${yq(spec.contract.baseline)}`,
    ...(spec.contract.ctqs.length
      ? [
          "    ctqs:",
          ...spec.contract.ctqs.flatMap((c) => [
            `      - id: ${yq(c.id)}`,
            `        persona: ${yq(c.persona)}`,
            `        metric: ${yq(c.metric)}`,
            `        spec_limit: ${yq(c.specLimit)}`,
            `        defect_definition: ${yq(c.defectDefinition)}`,
          ]),
        ]
      : ["    ctqs: []"]),
    "---",
  ];

  const body = [
    "",
    "",
    `# ${artifact.name}`,
    "",
    "## Purpose",
    "",
    artifact.l2Rationale,
    "",
    "## Provenance — traced truths (verbatim)",
    "",
    "This skill is justified by these entries in the pack's `process-spec.json`",
    "(pack root). If a truth below no longer holds, the skill's justification is",
    "void — report it to the factory rather than working around it.",
    "",
    ...truths.flatMap((t) => [
      `- **${t.id}** [${t.type}]: "${t.statement}"`,
      `  - Rationale: ${t.rationale}`,
    ]),
    ...(constraintIds.length
      ? [
          "",
          "Traced constraints (Theory of Constraints analysis):",
          "",
          `- **${spec.assessment.constraint.id}** [${spec.assessment.constraint.type}]: "${spec.assessment.constraint.statement}"`,
        ]
      : []),
    "",
    "## Role instructions (roles serving the same truths)",
    "",
    ...(roles.length
      ? roles.flatMap((r) => renderRoleSection(r)).slice(0, -1) // drop the last trailing blank
      : ["No role in this process serves these truths; the skill stands alone."]),
    "",
    "## Related skills",
    "",
    "Methodology dependencies of this pack — install and consult alongside:",
    "",
    ...bulletsOrNone(spec.methodologyDeps.map((d) => `\`${d}\``)),
    "",
    "## When You're Done",
    "",
    "Document what you did and how it went — outcome records are the pack's",
    "sensory half and feed the factory's scan stage.",
    "",
    "**What to record:**",
    "",
    "- Which steps you followed (or skipped)",
    "- Outcome: success | partial | failed",
    "- If failed: what broke and at what step",
    "- How long it took",
    "- What you'd do differently",
  ];

  return frontmatter.join("\n") + body.join("\n") + "\n";
}

function renderRoleSection(role: Role): string[] {
  return [
    `### ${role.name} (\`${role.id}\`)`,
    "",
    role.instructions,
    "",
    `- Output: ${role.outputHint}`,
    `- Accountable CTQs: ${role.ctqIds.length ? role.ctqIds.join(", ") : "(none)"}`,
    "",
  ];
}

// --- hooks/<name>.md and gates/<name>.md (spec stubs) ----------------------
//
// Disposition splits the stub's truth claims (PR #21 review): a generate stub
// honestly says it is not live code; a reuse_existing stub references LIVE
// machinery (e.g. the D-065 adversarial-review hook, which blocks today), so
// it must state that the live implementation's actual behavior governs — the
// pack's shadow birth phase describes the pack, never the live artifact.

const ENFORCEMENT_BY_PHASE: Record<ProcessSpec["contract"]["governancePhase"], string> = {
  shadow: "observe and record violations; never block",
  advisory: "warn and record violations; do not block",
  enforcement: "block the action until the violated condition is satisfied",
};

const DISPOSITION_NOTE: Record<Artifact["disposition"], string> = {
  generate: "generated by the process factory as part of this pack",
  reuse_existing: "reuses an existing capability; this stub documents the intent, no new enforcement is generated here",
  forge_new: "queued for skill-forge — see manifest/forge-handoff.json",
};

/**
 * Where the live capability a reuse_existing artifact references actually
 * lives, per the assessment inventory. Honest fallback when the inventory has
 * no located entry — the emitter never invents a path.
 */
function liveLocation(spec: ProcessSpec, artifact: Artifact): string {
  const entry = spec.assessment.inventory.find((e) => e.name === artifact.name && e.location !== "");
  return entry ? entry.location : "(location not recorded in the assessment inventory)";
}

function renderStubMd(spec: ProcessSpec, artifact: Artifact): string {
  const truths = tracedTruths(spec, artifact);
  const constraintIds = tracedConstraintIds(spec, artifact);
  const kindLabel = artifact.kind; // "hook" | "gate"
  const rel = artifact.relationships;
  const reuse = artifact.disposition === "reuse_existing";
  const location = reuse ? liveLocation(spec, artifact) : "";

  const lines = [
    `# ${artifact.name} — ${kindLabel} spec stub`,
    "",
    ...(reuse
      ? [
          `> **References LIVE machinery.** This ${kindLabel} reuses an existing capability`,
          `> that is live today at \`${location}\` — the live implementation's actual`,
          "> behavior governs, not this file. This stub records the pack's intent in",
          "> reusing it.",
        ]
      : [
          `> **Not live ${kindLabel} code.** This file is a deterministic spec stub emitted by`,
          "> the process-pack emitter. Live hook/gate scripts (concrete event binding,",
          "> matcher authoring, false-fire evaluation, lazy-agent judging) are a later",
          `> factory task; until then this document is the ${kindLabel}'s contract.`,
        ]),
    "",
    `- Kind: ${artifact.kind}`,
    `- Disposition: ${artifact.disposition} — ${DISPOSITION_NOTE[artifact.disposition]}`,
    `- Governance phase at birth: ${spec.contract.governancePhase}`,
    "",
    "## Intent (L2 rationale)",
    "",
    artifact.l2Rationale,
    "",
    "## Event",
    "",
    ...(reuse
      ? [
          "Bound in the live implementation (see the location above); this stub",
          "neither selects nor alters it.",
        ]
      : [
          "Unbound in this stub. The concrete Claude Code hook event is selected when",
          `the live ${kindLabel} script is authored; the firing point it must implement is`,
          "described by the matcher intent below.",
        ]),
    "",
    "## Matcher intent",
    "",
    ...(artifact.kind === "gate"
      ? [
          "Block progress exactly while any condition guarded by the traced truths",
          "below is unsatisfied — and never otherwise" +
            (reuse
              ? ". The live implementation already embodies this; verify against it rather than re-deriving."
              : " (false-fire evaluation gates the live version)."),
        ]
      : [
          "Fire exactly when a condition guarded by the traced truths below is at",
          "risk — and never otherwise" +
            (reuse
              ? ". The live implementation already embodies this; verify against it rather than re-deriving."
              : " (false-fire evaluation gates the live version)."),
        ]),
    "",
    "## Enforcement",
    "",
    // Two separate truth claims for reuse (PR #21 review): (a) the live
    // artifact's behavior governs — it may block today; (b) the pack's own
    // birth phase is shadow. Never claim a live blocking system "never blocks".
    ...(reuse
      ? [
          `- Live behavior governs: the reused ${kindLabel} at \`${location}\` enforces`,
          "  whatever it enforces today — including blocking, if that is its live",
          "  behavior. This pack does not change it.",
          `- Pack birth phase: "${spec.contract.governancePhase}" — this describes the pack's own`,
          `  instrumentation posture at birth, not the live ${kindLabel}'s enforcement.`,
        ]
      : [`- Phase "${spec.contract.governancePhase}": ${ENFORCEMENT_BY_PHASE[spec.contract.governancePhase]}.`]),
    `- Decision rule: ${spec.contract.decisionRule}`,
    `- Control plan: ${spec.contract.controlPlan.monitoringCadence} — ${spec.contract.controlPlan.response}.`,
    ...(artifact.kind === "gate" && !reuse
      ? [
          "- Lazy-agent test: before this gate leaves shadow, a judge must answer",
          '  "what is the cheapest path past this gate?" with evidence; cosmetic-',
          "  compliance answers fail the gate (design §6).",
        ]
      : []),
    "",
    "## Provenance — traced truths (verbatim)",
    "",
    ...truths.flatMap((t) => [
      `- **${t.id}** [${t.type}]: "${t.statement}"`,
      `  - Rationale: ${t.rationale}`,
    ]),
    ...(constraintIds.length
      ? [
          "",
          "Traced constraints (Theory of Constraints analysis):",
          "",
          `- **${spec.assessment.constraint.id}** [${spec.assessment.constraint.type}]: "${spec.assessment.constraint.statement}"`,
        ]
      : []),
    "",
    "## Relationships",
    "",
    `- depends_on: ${rel.dependsOn.join(", ") || "(none)"}`,
    `- complements: ${rel.complements.join(", ") || "(none)"}`,
    `- composes_with: ${rel.composesWith.join(", ") || "(none)"}`,
    `- supersedes: ${rel.supersedes.join(", ") || "(none)"}`,
    `- binds_tools: ${rel.bindsTools.join(", ") || "(none)"}`,
  ];

  return lines.join("\n") + "\n";
}

// --- manifest/metrics.json (the pack's sensory half, design §5) ------------

function renderMetricsManifest(spec: ProcessSpec): string {
  return jsonFile({
    ctqs: spec.contract.ctqs,
    baseline: spec.contract.baseline,
    decisionRule: spec.contract.decisionRule,
    controlPlan: spec.contract.controlPlan,
    governancePhase: spec.contract.governancePhase,
    knobs: spec.knobs,
  });
}

// --- manifest/forge-handoff.json (disposition=forge_new → skill-forge) -----

function renderForgeHandoff(spec: ProcessSpec): string {
  const handoff = spec.artifacts
    .filter((a) => a.disposition === "forge_new")
    .map((a) => ({
      name: a.name,
      kind: a.kind,
      traceability: a.traceability,
      l2Rationale: a.l2Rationale,
      relationships: a.relationships,
    }));
  return jsonFile(handoff);
}
