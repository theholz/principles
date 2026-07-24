import realFs from "fs-extra";
import path from "path";
import { Truth } from "../../shared/types";
import { Artifact, ProcessSpec, Role } from "../types";
import type { EmitDeps, EmitFs } from "./processPack";

/**
 * Grok pack emitter: pure deterministic templating from a ProcessSpec to a
 * Grok TUI harness pack (agents, personas, skills, metrics, provenance).
 * Sibling of processPack.ts (Claude Code plugin layout) — invariant 3: the
 * Claude path is untouched. NO LLM, NO network.
 *
 * Layout:
 *   agents/<role.name>.md           one agent md per roles[] entry
 *   personas/<role.name>.toml       persona overlay + [[outputs]] handoff
 *   skills/<name>/SKILL.md          kind=skill, disposition=generate
 *   manifest/metrics.json           pack-level sensory half
 *   manifest/forge-handoff.json     disposition=forge_new → skill-forge
 *   process-spec.json               the input spec verbatim (provenance)
 *
 * Atomicity (design §9 / processPack pattern): render all files in memory
 * first, write to a temp sibling, rename into place. Existing outDir is refused.
 *
 * Workflow emit (subtasks → .rhai) is Task 3 — not this module.
 */

export type { EmitDeps, EmitFs };

export function emitGrokPack(spec: ProcessSpec, outDir: string, deps: EmitDeps = {}): string {
  const fs: EmitFs = deps.fs ?? realFs;
  if (fs.existsSync(outDir)) {
    throw new Error(`Refusing to emit: output directory already exists — ${outDir}`);
  }

  // Render everything first: templating failures throw before any write.
  const files = renderGrokPack(spec);

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
export function renderGrokPack(spec: ProcessSpec): [string, string][] {
  const files: [string, string][] = [];
  const seen = new Set<string>();
  // Use POSIX-style relative paths so Object.fromEntries keys are stable in tests.
  const add = (rel: string, content: string) => {
    const normalized = rel.split(path.sep).join("/");
    if (seen.has(normalized)) {
      throw new Error(
        `Templating failure: duplicate emitted path "${normalized}" — artifact/role names must be unique`
      );
    }
    seen.add(normalized);
    files.push([normalized, content]);
  };

  for (const role of spec.roles) {
    const name = safeRoleName(role);
    add(`agents/${name}.md`, renderAgentMd(spec, role));
    add(`personas/${name}.toml`, renderPersonaToml(role));
  }

  for (const artifact of spec.artifacts) {
    if (artifact.kind === "skill" && artifact.disposition === "generate") {
      add(`skills/${safeArtifactName(artifact)}/SKILL.md`, renderSkillMd(spec, artifact));
    }
    // forge_new → forge-handoff only; reuse_existing → no file.
    // hook/gate generate stubs and workflow emit are later tasks — not dropped
    // as claimed capabilities here because Grok packs surface roles + skills first.
  }

  add("manifest/metrics.json", renderMetricsManifest(spec));
  add("manifest/forge-handoff.json", renderForgeHandoff(spec));
  add("process-spec.json", jsonFile(spec));

  return files;
}

const jsonFile = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function safeRoleName(role: Role): string {
  if (!SAFE_NAME.test(role.name)) {
    throw new Error(
      `Templating failure: role name ${JSON.stringify(role.name)} is not filesystem-safe ` +
        `(expected /^[A-Za-z0-9][A-Za-z0-9_-]*$/)`
    );
  }
  return role.name;
}

function safeArtifactName(artifact: Artifact): string {
  if (!SAFE_NAME.test(artifact.name)) {
    throw new Error(
      `Templating failure: artifact name ${JSON.stringify(artifact.name)} is not filesystem-safe ` +
        `(expected /^[A-Za-z0-9][A-Za-z0-9_-]*$/)`
    );
  }
  return artifact.name;
}

/** First sentence of instructions, or outputHint, for agent description. */
function roleDescription(role: Role): string {
  const fromInstructions = role.instructions.split(/(?<=\.)\s+/)[0]?.trim();
  if (fromInstructions) return fromInstructions;
  return role.outputHint.trim() || role.name;
}

/** Resolve cited truth ids (truths + assumptions) or throw. */
function resolveTruths(spec: ProcessSpec, ids: string[], ctx: string): Truth[] {
  const pool = [...spec.foundations.truths, ...spec.foundations.assumptions];
  return ids.map((id) => {
    const truth = pool.find((t) => t.id === id);
    if (!truth) {
      throw new Error(
        `Templating failure: ${ctx} cites unknown truth id "${id}" — refusing to emit unverifiable provenance`
      );
    }
    return truth;
  });
}

// --- agents/<name>.md ------------------------------------------------------

function renderAgentMd(spec: ProcessSpec, role: Role): string {
  const truths = resolveTruths(spec, role.servesTruths, `role "${role.name}"`);
  const description = roleDescription(role);

  const lines = [
    "---",
    `name: ${role.name}`,
    "description: >",
    `  ${description}`,
    "model: inherit",
    "---",
    "",
    `# ${role.name}`,
    "",
    "You are a process-factory role. Serve only the truths listed below.",
    "",
    "## Serves truths",
    "",
    ...(truths.length
      ? truths.map((t) => `- ${t.id}: ${t.statement}`)
      : ["- (none)"]),
    "",
    "## Instructions",
    "",
    role.instructions,
    "",
    "## Output",
    "",
    role.outputHint,
    "",
    "## Provenance",
    "",
    `process-spec: ${spec.meta.name}@${spec.meta.version} role id=${role.id} subtask=${role.subtaskId}`,
    `servesTruths: ${role.servesTruths.join(", ") || "(none)"}`,
    `ctqIds: ${role.ctqIds.join(", ") || "(none)"}`,
    "",
  ];

  return lines.join("\n");
}

// --- personas/<name>.toml --------------------------------------------------

/** Escape a string for TOML basic multiline string (""") content. */
function tomlMultiline(s: string): string {
  // Avoid closing the multiline string early; double any sequence of three quotes.
  return s.replace(/"""/g, '\\"""');
}

function tomlBasicString(s: string): string {
  return JSON.stringify(s); // TOML basic strings accept JSON-style escaping
}

function renderPersonaToml(role: Role): string {
  const description = roleDescription(role);
  const instructions = [
    role.instructions,
    "",
    `Output: ${role.outputHint}`,
    role.ctqIds.length ? `Accountable CTQs: ${role.ctqIds.join(", ")}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");

  const lines = [
    `description = ${tomlBasicString(description)}`,
    "instructions = \"\"\"",
    tomlMultiline(instructions),
    '"""',
    "",
    'default_capability_mode = "all"',
    "",
    "[[outputs]]",
    'name = "handoff_file"',
    'io_type = "file"',
    "required = false",
    'description = "Path for role handoff artifact when used in a workflow"',
    "",
  ];

  return lines.join("\n");
}

// --- skills/<name>/SKILL.md ------------------------------------------------
// Minimal skill body for Grok packs: name, purpose, provenance. Full Claude
// skill frontmatter lives in processPack; Grok packs keep skills discoverable
// without inventing Claude-plugin-only routing fields.

function renderSkillMd(spec: ProcessSpec, artifact: Artifact): string {
  const truths = resolveTruths(
    spec,
    artifact.traceability.truthIds,
    `artifact "${artifact.name}"`
  );

  for (const id of artifact.traceability.constraintIds) {
    if (id !== spec.assessment.constraint.id) {
      throw new Error(
        `Templating failure: artifact "${artifact.name}" cites unknown constraint id "${id}" — refusing to emit unverifiable provenance`
      );
    }
  }

  const lines = [
    "---",
    `name: ${artifact.name}`,
    `description: ${JSON.stringify(artifact.l2Rationale)}`,
    `version: ${JSON.stringify(spec.meta.version)}`,
    "---",
    "",
    `# ${artifact.name}`,
    "",
    "## Purpose",
    "",
    artifact.l2Rationale,
    "",
    "## Provenance — traced truths (verbatim)",
    "",
    ...(truths.length
      ? truths.flatMap((t) => [
          `- **${t.id}** [${t.type}]: "${t.statement}"`,
          `  - Rationale: ${t.rationale}`,
        ])
      : ["- (none)"]),
    ...(artifact.traceability.constraintIds.length
      ? [
          "",
          "Traced constraints:",
          "",
          `- **${spec.assessment.constraint.id}** [${spec.assessment.constraint.type}]: "${spec.assessment.constraint.statement}"`,
        ]
      : []),
    "",
    "## When You're Done",
    "",
    "Document what you did and how it went — outcome records feed the factory's scan stage.",
    "",
  ];

  return lines.join("\n");
}

// --- manifest/metrics.json + forge-handoff.json ----------------------------
// Local copies of processPack private helpers (prefer no processPack change).

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
