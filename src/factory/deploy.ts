import path from "path";

/**
 * DEPLOY stage (design §7 DEPLOY row): ship an emitted process pack into the
 * engram-plugins checkout as a BRANCH + DRAFT PR — this module knows no other
 * path (design §10 governance-bypass row: "deploy.ts only knows the
 * branch+draft-PR path; D-065 gate enforces independently"). It never pushes
 * to main and never merges; the adversarial-review gate lives outside.
 *
 * Everything effectful is injected (exec + fs + clock), so tests script the
 * whole git/gh conversation without ever spawning a real subprocess.
 *
 * Refusals (before any exec): a pack directory missing its provenance chain —
 * .claude-plugin/plugin.json, process-spec.json, manifest/metrics.json — never
 * deploys (design §5: the sensory half is baked in at birth; a pack without
 * metrics cannot be measured, so it must not ship).
 *
 * Conflict check (design §9): the portable skill-forge conflict_check.py is
 * resolved under the engram-plugins root, never hardcoded elsewhere. Missing
 * script or a failing run does NOT fail the deploy — the skip is recorded in
 * the PR body so reviewers see it.
 */

// ---------------------------------------------------------------------------
// Injected capabilities
// ---------------------------------------------------------------------------

export type ExecResult = { code: number; stdout: string; stderr: string };

/** Child-process capability. Production binds child_process; tests script it. */
export type ExecFn = (cmd: string, args: string[], cwd?: string) => Promise<ExecResult>;

/** Minimal fs surface for deploy. fs-extra satisfies it (see factoryCli). */
export interface DeployFs {
  readFile(p: string): string;
  writeFile(p: string, data: string): void;
  exists(p: string): boolean;
  copyDir(from: string, to: string): void;
}

export interface DeployOptions {
  /** Root of the local engram-plugins git checkout (the deployment surface). */
  engramPluginsRoot: string;
  exec: ExecFn;
  fs: DeployFs;
  /** Injected clock (branch timestamp + registry deployedAt). Defaults to real time. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Registry (factory-registry.json at the engram-plugins repo root)
// ---------------------------------------------------------------------------

/** One deployment record; the file is a plain JSON array of these. */
export interface FactoryRegistryEntry {
  name: string;
  version: string;
  /** meta.version of the embedded process-spec.json (provenance pointer). */
  specVersion: string;
  /** ISO timestamp from the injected clock. */
  deployedAt: string;
  target: "claude-code-plugin";
  /** Repo-relative POSIX path to the deployed pack's metrics manifest. */
  metricsLocation: string;
}

export interface DeployReport {
  branch: string;
  /** Parsed from gh stdout; the literal "unknown" when unparseable (not a failure). */
  prUrl: string;
  registryEntry: FactoryRegistryEntry;
  conflictCheck: "ran" | "skipped";
  /** Every exec invocation, in order, as "cmd arg arg ...". */
  commands: string[];
}

/** Where the portable conflict check lives under an engram-plugins checkout. */
export const CONFLICT_CHECK_RELPATH = path.join(
  "plugins",
  "skill-forge",
  "skills",
  "skill-forge",
  "scripts",
  "portable",
  "conflict_check.py"
);

export const REGISTRY_FILENAME = "factory-registry.json";

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

export async function deployProcessPack(packDir: string, opts: DeployOptions): Promise<DeployReport> {
  const { engramPluginsRoot: root, exec, fs } = opts;
  const now = opts.now ?? (() => new Date());

  // -- 1. Validate the pack BEFORE any exec: no provenance/metrics, no deploy.
  const pluginJson = readRequiredJson(fs, packDir, path.join(".claude-plugin", "plugin.json"));
  const processSpec = readRequiredJson(fs, packDir, "process-spec.json");
  const metrics = readRequiredJson(fs, packDir, path.join("manifest", "metrics.json"));

  const packName = requireSafeString(pluginJson, "name", ".claude-plugin/plugin.json", SAFE_NAME);
  const version = requireSafeString(pluginJson, "version", ".claude-plugin/plugin.json", SAFE_VERSION);
  const specVersion = requireSpecVersion(processSpec);
  const governancePhase = requireString(metrics, "governancePhase", "manifest/metrics.json");

  const deployedAtDate = now();
  const branch = `factory/deploy-${packName}-${timestampSlug(deployedAtDate)}`;
  const packRelDir = path.join("plugins", packName, version);
  const registryPath = path.join(root, REGISTRY_FILENAME);

  const commands: string[] = [];
  const run = async (cmd: string, args: string[]): Promise<ExecResult> => {
    commands.push([cmd, ...args].join(" "));
    return exec(cmd, args, root);
  };
  /** Hard-error variant: any nonzero exit aborts the deploy naming the command. */
  const must = async (cmd: string, args: string[]): Promise<ExecResult> => {
    const res = await run(cmd, args);
    if (res.code !== 0) {
      throw new Error(
        `Deploy failed: command "${[cmd, ...args].join(" ")}" exited ${res.code}` +
          (res.stderr.trim() ? ` — ${res.stderr.trim()}` : "")
      );
    }
    return res;
  };

  // -- 2. Branch off the checkout's current HEAD, copy the pack in.
  await must("git", ["checkout", "-b", branch]);
  fs.copyDir(packDir, path.join(root, packRelDir));

  // -- 3. Conflict check: best-effort, never fails the deploy (design §9).
  const conflict = await runConflictCheck(fs, run, root, path.join(root, packRelDir, "skills"));

  // -- 4. Registry update in the same PR (design §7 DEPLOY row).
  const registryEntry: FactoryRegistryEntry = {
    name: packName,
    version,
    specVersion,
    deployedAt: deployedAtDate.toISOString(),
    target: "claude-code-plugin",
    metricsLocation: `plugins/${packName}/${version}/manifest/metrics.json`,
  };
  fs.writeFile(registryPath, renderRegistry(loadRegistry(fs, registryPath), registryEntry));

  // -- 5. Stage ONLY the deploy's own paths, commit, push the branch, open a
  //       DRAFT PR. No push to main, no merge — ever.
  await must("git", ["add", "--", packRelDir, REGISTRY_FILENAME]);
  await must("git", ["commit", "-m", `factory deploy: ${packName}@${version}`]);
  await must("git", ["push", "-u", "origin", branch]);
  const pr = await must("gh", [
    "pr",
    "create",
    "--draft",
    "--title",
    `factory deploy: ${packName}@${version}`,
    "--body",
    renderPrBody(packName, version, specVersion, governancePhase, conflict),
  ]);

  return {
    branch,
    prUrl: parsePrUrl(pr.stdout),
    registryEntry,
    conflictCheck: conflict.status,
    commands,
  };
}

// ---------------------------------------------------------------------------
// Pack validation helpers (all refusals happen before any exec)
// ---------------------------------------------------------------------------

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function refuse(rel: string, why: string): never {
  throw new Error(`Refusing to deploy: ${rel} ${why} — a pack without provenance/metrics never deploys`);
}

function readRequiredJson(fs: DeployFs, packDir: string, rel: string): Record<string, unknown> {
  const abs = path.join(packDir, rel);
  if (!fs.exists(abs)) refuse(rel, `is missing from ${packDir}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFile(abs));
  } catch (e) {
    refuse(rel, `is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse(rel, "is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string, rel: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) refuse(rel, `has no string "${key}"`);
  return v;
}

function requireSafeString(
  obj: Record<string, unknown>,
  key: string,
  rel: string,
  pattern: RegExp
): string {
  const v = requireString(obj, key, rel);
  if (!pattern.test(v)) {
    throw new Error(
      `Refusing to deploy: ${rel} "${key}" ${JSON.stringify(v)} is not path/ref-safe (expected ${pattern})`
    );
  }
  return v;
}

function requireSpecVersion(processSpec: Record<string, unknown>): string {
  const meta = processSpec["meta"];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    refuse("process-spec.json", 'has no "meta" object');
  }
  return requireString(meta as Record<string, unknown>, "version", "process-spec.json meta");
}

/** "2026-07-21T12:00:00.000Z" → "2026-07-21T12-00-00-000Z" (git-ref-safe). */
const timestampSlug = (d: Date): string => d.toISOString().replace(/[:.]/g, "-");

// ---------------------------------------------------------------------------
// Conflict check (soft: skip recorded for reviewers, never a deploy failure)
// ---------------------------------------------------------------------------

type ConflictOutcome = { status: "ran"; summary: string } | { status: "skipped"; reason: string };

async function runConflictCheck(
  fs: DeployFs,
  run: (cmd: string, args: string[]) => Promise<ExecResult>,
  root: string,
  skillsDir: string
): Promise<ConflictOutcome> {
  const script = path.join(root, CONFLICT_CHECK_RELPATH);
  if (!fs.exists(script)) {
    return { status: "skipped", reason: `conflict_check.py not found at ${script}` };
  }
  let res: ExecResult;
  try {
    res = await run("python3", [script, skillsDir]);
  } catch (e) {
    return { status: "skipped", reason: `python3 failed to run (${e instanceof Error ? e.message : String(e)})` };
  }
  if (res.code !== 0) {
    return {
      status: "skipped",
      reason: `conflict_check.py exited ${res.code}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}`,
    };
  }
  return { status: "ran", summary: res.stdout.trim() || "(no output)" };
}

// ---------------------------------------------------------------------------
// Registry rendering
// ---------------------------------------------------------------------------

function loadRegistry(fs: DeployFs, registryPath: string): FactoryRegistryEntry[] {
  if (!fs.exists(registryPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFile(registryPath));
  } catch (e) {
    // Silently clobbering a corrupt registry would erase deployment history.
    throw new Error(
      `Deploy failed: existing ${REGISTRY_FILENAME} is not valid JSON (${
        e instanceof Error ? e.message : String(e)
      }) — fix it by hand before deploying`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Deploy failed: existing ${REGISTRY_FILENAME} is not a JSON array — fix it by hand before deploying`);
  }
  return parsed as FactoryRegistryEntry[];
}

/** Replace the same name@version entry in place if present; otherwise append. */
function renderRegistry(existing: FactoryRegistryEntry[], entry: FactoryRegistryEntry): string {
  const idx = existing.findIndex((e) => e.name === entry.name && e.version === entry.version);
  const next = idx >= 0 ? existing.map((e, i) => (i === idx ? entry : e)) : [...existing, entry];
  return JSON.stringify(next, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// PR body + URL parsing
// ---------------------------------------------------------------------------

function renderPrBody(
  name: string,
  version: string,
  specVersion: string,
  governancePhase: string,
  conflict: ConflictOutcome
): string {
  return [
    `## Factory deployment: ${name}@${version}`,
    "",
    `- Pack: \`${name}\` version \`${version}\` (process-spec version \`${specVersion}\`)`,
    `- Governance phase at birth: \`${governancePhase}\``,
    `- Registry: entry updated in \`${REGISTRY_FILENAME}\` in this same PR`,
    `- Metrics manifest: \`plugins/${name}/${version}/manifest/metrics.json\``,
    "",
    "## Conflict check",
    "",
    conflict.status === "ran" ? conflict.summary : `conflict check: SKIPPED (${conflict.reason})`,
    "",
    "---",
    "Draft PR opened by the process factory's deploy stage. Branch + draft PR is",
    "the only deploy path (D-016/D-065); adversarial review gates the merge.",
  ].join("\n");
}

/** First https URL in gh's stdout; "unknown" if none — never a failure. */
function parsePrUrl(stdout: string): string {
  const m = stdout.match(/https:\/\/\S+/);
  return m ? m[0] : "unknown";
}
