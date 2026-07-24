import realFs from "fs-extra";
import path from "path";
import { Truth } from "../../shared/types";
import { Artifact, ProcessSpec, Role } from "../types";
import type { EmitDeps, EmitFs } from "./processPack";

/**
 * Grok pack emitter: pure deterministic templating from a ProcessSpec to a
 * Grok TUI harness pack (agents, personas, skills, workflows, metrics, provenance).
 * Sibling of processPack.ts (Claude Code plugin layout) — invariant 3: the
 * Claude path is untouched. NO LLM, NO network.
 *
 * Layout:
 *   agents/<role.name>.md           one agent md per roles[] entry
 *   personas/<role.name>.toml       persona overlay + [[outputs]] handoff
 *   skills/<name>/SKILL.md          kind=skill, disposition=generate
 *   workflows/<meta.name>.rhai      subtask DAG → phase()/agent() script
 *   manifest/metrics.json           pack-level sensory half
 *   manifest/forge-handoff.json     disposition=forge_new → skill-forge
 *   process-spec.json               the input spec verbatim (provenance)
 *
 * Atomicity (design §9 / processPack pattern): render all files in memory
 * first, write to a temp sibling, rename into place. Existing outDir is refused.
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
    // hook/gate generate stubs are later tasks — not dropped as claimed
    // capabilities here because Grok packs surface roles + skills + workflow first.
  }

  if (spec.foundations.subtasks.length > 0) {
    const wfName = safeWorkflowName(spec.meta.name);
    add(`workflows/${wfName}.rhai`, renderWorkflowRhai(spec));
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

/** Workflow filename / meta.name: lowercase letters, digits, hyphens (create-workflow). */
function safeWorkflowName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `Templating failure: meta.name ${JSON.stringify(name)} is not a valid workflow name ` +
        `(expected lowercase letters, digits, hyphens)`
    );
  }
  return name;
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

// --- workflows/<meta.name>.rhai --------------------------------------------
// create-workflow constraints: pure-literal `let meta` first; self-contained
// agent prompts (no fork_context); guard results with `r != () && r.success`.

/**
 * Kahn-style levelize: group subtask ids by dependency depth.
 * Same-level ids have all deps already satisfied (may run parallel later).
 * Order within a level preserves input order. Throws on cycles / unknown deps
 * that leave a non-empty remainder with no ready nodes.
 */
export function subtaskLevels(
  subtasks: { id: string; dependsOn: string[] }[]
): string[][] {
  const known = new Set(subtasks.map((s) => s.id));
  // Only edges to ids present in this set count (external deps ignored).
  const remaining = new Map<string, Set<string>>();
  for (const s of subtasks) {
    remaining.set(
      s.id,
      new Set(s.dependsOn.filter((d) => known.has(d)))
    );
  }

  const levels: string[][] = [];
  const done = new Set<string>();

  while (done.size < subtasks.length) {
    // Preserve input order within the level.
    const level = subtasks
      .filter((s) => !done.has(s.id) && (remaining.get(s.id)?.size ?? 0) === 0)
      .map((s) => s.id);

    if (level.length === 0) {
      const stuck = subtasks
        .filter((s) => !done.has(s.id))
        .map((s) => s.id)
        .join(", ");
      throw new Error(
        `Templating failure: cyclic or unsatisfiable subtask dependsOn (stuck: ${stuck})`
      );
    }

    levels.push(level);
    for (const id of level) {
      done.add(id);
      for (const deps of remaining.values()) {
        deps.delete(id);
      }
    }
  }

  return levels;
}

/** Escape a string for a Rhai double-quoted string literal. */
function rhaiString(s: string): string {
  return (
    '"' +
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t") +
    '"'
  );
}

/** Safe Rhai identifier fragment from a subtask id (s1, s2, …). */
function rhaiIdent(id: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
    throw new Error(
      `Templating failure: subtask id ${JSON.stringify(id)} is not a valid Rhai identifier fragment`
    );
  }
  return id;
}

function renderWorkflowRhai(spec: ProcessSpec): string {
  const wfName = safeWorkflowName(spec.meta.name);
  const subtasks = spec.foundations.subtasks;
  const levels = subtaskLevels(subtasks);
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const roleBySubtask = new Map(spec.roles.map((r) => [r.subtaskId, r]));

  // Flatten levels for meta.phases (one phase title per subtask, sequential
  // agent() within a level for v1; parallel same-level is a later phase).
  const flatOrder = levels.flat();

  const phaseEntries = flatOrder.map((id) => {
    const st = byId.get(id)!;
    const detail = st.description.split(/(?<=\.)\s+/)[0]?.trim() || st.description;
    return `        #{ title: ${rhaiString(id)}, detail: ${rhaiString(detail)} },`;
  });

  const lines: string[] = [
    "let meta = #{",
    `    name: ${rhaiString(wfName)},`,
    `    description: ${rhaiString(spec.meta.problemStatement)},`,
    "    phases: [",
    ...phaseEntries,
    "    ],",
    "};",
    "",
  ];

  for (const id of flatOrder) {
    const st = byId.get(id)!;
    const role = roleBySubtask.get(id);
    const varName = `r_${rhaiIdent(id)}`;

    // Self-contained prompt: cold subagent must not rely on parent context.
    const promptParts: string[] = [];
    if (role) {
      promptParts.push(role.instructions.trim());
      promptParts.push("");
      promptParts.push(`Output: ${role.outputHint.trim()}`);
      promptParts.push("");
    }
    promptParts.push(`Subtask ${id}: ${st.description.trim()}`);
    promptParts.push(
      "Do the work with tools as needed; report a concrete outcome, not a plan."
    );
    const prompt = promptParts.join("\n");

    const label = role ? role.name : id;
    const optsLines = [
      `    label: ${rhaiString(label)},`,
      ...(role ? [`    agent_type: ${rhaiString(role.name)},`] : []),
      '    capability_mode: "all",',
    ];

    lines.push(`// Subtask ${id}${role ? ` — ${role.name}` : " (no dedicated role)"}`);
    lines.push(`phase(${rhaiString(id)});`);
    lines.push(`let ${varName} = agent(${rhaiString(prompt)}, #{`);
    lines.push(...optsLines);
    lines.push("});");
    lines.push(
      `if ${varName} != () && ${varName}.success {`,
      `    log(${rhaiString(`subtask ${id} completed`)});`,
      `} else {`,
      `    log(${rhaiString(`subtask ${id} failed or returned unit`)});`,
      `}`,
      ""
    );
  }

  lines.push(
    `complete(#{ summary: ${rhaiString(`${wfName} workflow finished`)} });`,
    ""
  );

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
