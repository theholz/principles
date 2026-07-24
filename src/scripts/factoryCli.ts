import path from "path";
import { execFile } from "child_process";
import fs from "fs-extra";
import { Llm, LlmRequest } from "../llm/gateway";
import {
  resolveDefaultLlm,
  providerSupportsWebTools,
  resolveProviderConfig,
} from "../llm/resolveLlm";
import { failures } from "../shared/types";
import { loadProcessSpec } from "../factory/loadSpec";
import { validateProcessSpec } from "../factory/validators";
import { emitProcessPack, renderPack, EmitFs } from "../factory/emitters/processPack";
import { emitGrokPack, renderGrokPack } from "../factory/emitters/grokPack";
import { deployProcessPack, DeployFs, ExecFn } from "../factory/deploy";
import { compileProcess, CompileResult } from "../factory/compile";
import { readOutcomes, scanPack, ImprovementProposal } from "../factory/scan";
import { BaselineEntry, EngramClient, loadBaselineInventory } from "../factory/assess";

/**
 * Process-factory CLI (design §7): `factory compile | emit | emit-grok | deploy | scan | models`.
 * All six verbs are live. `models` is a read-only introspection verb: one GET
 * against the configured provider's `/models` endpoint (no LLM call) via the
 * injected `deps.fetchJson`. `emit` and `deploy` are deliberately deterministic
 * and offline — no model call on either path, and the LLM gateway is resolved
 * LAZILY (first model call only) so a keyless environment can still emit and
 * deploy without provider warnings. `compile` (stages 1–4) and `scan`
 * (measure-and-propose) take the injected `deps.llm`; tests pass scripted
 * fakes, the require.main binding passes the fork's resolveDefaultLlm.
 * Convention mirrors src/scripts/researchPilot.ts: run(argv, deps) with
 * injected FactoryDeps, switch(cmd), require.main binding at the bottom.
 *
 * HITL gates are structural, not advisory: compile's terminal success is a
 * spec on disk awaiting operator review (`factory emit <spec>` is a separate,
 * human-invoked step), and scan's proposals are printed/written for the
 * needs-review queue — NEVER auto-applied (D-044).
 *
 * Exit codes: 0 success (including compile's build_nothing and scan's
 * insufficient_data/healthy — clean, informative outcomes) · 1 operational
 * failure (missing/invalid spec or dump, validator failure, emit/deploy
 * refusal, missing engram-plugins root, missing LLM) · 2 usage error
 * (unknown verb/flag, missing required argument).
 */

export interface FactoryDeps {
  readFile: (p: string) => string;
  exists: (p: string) => boolean;
  /** Filesystem surface handed to emitProcessPack (fs-extra in production);
   * compile and scan also write their spec/proposal JSON through it so tests
   * stay disk-free. */
  emitFs: EmitFs;
  /** Filesystem surface handed to deployProcessPack (fs-extra in production). */
  deployFs: DeployFs;
  /** Child-process capability for deploy (real child_process in production). */
  exec: ExecFn;
  /** Default engram-plugins checkout (env FACTORY_ENGRAM_PLUGINS_ROOT); --engram-root overrides. */
  engramPluginsRoot?: string;
  /** LLM for compile and scan (resolveDefaultLlm in production; fakes in tests).
   * emit and deploy never touch it. */
  llm?: Llm;
  /** Whether compile may run the landscape survey (providerSupportsWebTools()
   * in production — invariant 1: the one sanctioned generation-side web call). */
  webSurvey?: boolean;
  /** Optional live Engram skill-router client for compile's --engram flag.
   * No production client is wired yet; absent, the flag warns and degrades
   * gracefully to filesystem inventory (design §9). */
  engram?: EngramClient;
  /** JSON GET for the `models` verb (tests inject; absent, a global-fetch
   * default is used). Must reject on network failure and throw on non-2xx
   * with the HTTP status in the message so cmdModels can surface it. */
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown>;
  log: (s: string) => void;
  error: (s: string) => void;
}

const USAGE = [
  "Usage: factory <verb>",
  '  compile "<problem>" [--out <spec-path>] [--roots <dir,dir>] [--engram] [--baseline <file>]',
  "                                                                          stages 1-4; stops at the spec-approval HITL gate;",
  "                                                                          --baseline: operator-verified inventory JSON (Baseline Accord as input)",
  "  emit <spec-path> [--out <dir>]                                          deterministic pack emission from an approved spec",
  "  emit-grok <spec-path> [--out <dir>]                                     deterministic Grok TUI pack emission (agents/personas/skills)",
  "  deploy <pack-dir> [--engram-root <dir>]                                 branch + draft PR only",
  "  scan --spec <spec-path> --outcomes <dump-path> [--min-sample N] [--out <path>]",
  "                                                                          measure-and-propose; proposals are never auto-applied",
  "  models                                                                  list model families/ids visible to the configured provider key",
].join("\n");

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

interface CompileArgs {
  problem: string;
  outPath: string;
  roots?: string[];
  engram: boolean;
  baselinePath?: string;
}

function parseCompileArgs(rest: string[]): CompileArgs | { badUsage: string } {
  let problem: string | undefined;
  let outPath: string | undefined;
  let roots: string[] | undefined;
  let engram = false;
  let baselinePath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") {
      const raw = rest[++i];
      if (!raw || raw.startsWith("--")) return { badUsage: "--out requires a file argument" };
      outPath = raw;
    } else if (a === "--baseline") {
      const raw = rest[++i];
      if (!raw || raw.startsWith("--")) return { badUsage: "--baseline requires a file argument" };
      baselinePath = raw;
    } else if (a === "--roots") {
      const raw = rest[++i];
      if (!raw || raw.startsWith("--")) return { badUsage: "--roots requires a comma-separated directory list" };
      roots = raw
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      if (roots.length === 0) return { badUsage: "--roots requires at least one directory" };
    } else if (a === "--engram") {
      engram = true;
    } else if (a.startsWith("--")) {
      return { badUsage: `Unknown flag: ${a}` };
    } else if (problem === undefined) {
      problem = a;
    } else {
      return { badUsage: `Unexpected extra argument: ${a}` };
    }
  }
  if (problem === undefined || problem.trim() === "") {
    return { badUsage: 'compile requires a "<problem>" argument' };
  }
  return { problem, outPath: outPath ?? "process-spec.json", roots, engram, baselinePath };
}

/** Escalations surfaced loudly on stderr, on EVERY compile outcome (invariant 5). */
function printEscalations(deps: FactoryDeps, escalations: string[]): void {
  if (escalations.length === 0) return;
  deps.error(`ESCALATIONS (${escalations.length}) — non-converged judged stages, operator attention required:`);
  for (const line of escalations) deps.error(`  !! ${line}`);
}

async function cmdCompile(deps: FactoryDeps, rest: string[]): Promise<number> {
  const parsed = parseCompileArgs(rest);
  if ("badUsage" in parsed) {
    deps.error(`${parsed.badUsage}. ${USAGE}`);
    return 2;
  }
  if (!deps.llm) {
    deps.error("compile requires an LLM, and none is configured in FactoryDeps.");
    return 1;
  }
  if (parsed.engram && !deps.engram) {
    deps.error(
      "--engram requested but no Engram client is wired in this build — continuing with filesystem inventory only."
    );
  }

  // Operator baseline (Baseline Accord as INPUT): loaded and validated BEFORE
  // any model call — a missing or invalid baseline file is an operational
  // error, never a silent fallback to scan-only inventory (the whole point is
  // that unverified reuse claims must not enter as ground truth).
  let baseline: BaselineEntry[] | undefined;
  if (parsed.baselinePath) {
    if (!deps.exists(parsed.baselinePath)) {
      deps.error(`No baseline inventory found at ${parsed.baselinePath} — nothing compiled.`);
      return 1;
    }
    try {
      baseline = loadBaselineInventory(deps.readFile(parsed.baselinePath));
    } catch (e) {
      deps.error(
        `Failed to load baseline inventory ${parsed.baselinePath}: ${e instanceof Error ? e.message : String(e)}`
      );
      return 1;
    }
  }

  // Default inventory roots: the engram-plugins checkout's plugins/ dir when
  // configured, else none (assess reports unavailable roots and continues).
  const roots =
    parsed.roots ?? (deps.engramPluginsRoot ? [path.join(deps.engramPluginsRoot, "plugins")] : []);

  let result: CompileResult;
  try {
    result = await compileProcess(deps.llm, parsed.problem, {
      roots,
      webSurvey: deps.webSurvey ?? false,
      engram: parsed.engram ? deps.engram : undefined,
      baseline,
      outPath: parsed.outPath,
      // Written through emitFs so tests observe the write without disk.
      writeFile: (p, c) => {
        deps.emitFs.ensureDirSync(path.dirname(p));
        deps.emitFs.writeFileSync(p, c);
      },
    });
  } catch (e) {
    deps.error(`Compile failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  switch (result.status) {
    case "build_nothing":
      // A valid, cheap outcome (design §4, §9): verdict + evidence are in the report.
      for (const line of result.report) deps.log(line);
      printEscalations(deps, result.escalations);
      return 0;
    case "validation_failed":
      // Failing criteria are in the report; spec was returned for inspection, never written.
      for (const line of result.report) deps.error(line);
      printEscalations(deps, result.escalations);
      return 1;
    case "spec_ready":
      for (const line of result.report) deps.log(line);
      deps.log(`Spec: ${parsed.outPath}`);
      deps.log(
        `HITL: review the spec, then run \`yarn factory emit ${parsed.outPath}\` — ` +
          `compile never emits a pack; approval is a separate human step (structural gate).`
      );
      printEscalations(deps, result.escalations);
      return 0;
  }
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

function parseEmitArgs(
  rest: string[],
  verb: "emit" | "emit-grok" = "emit"
): { specPath: string; outDir?: string } | { badUsage: string } {
  let specPath: string | undefined;
  let outDir: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") {
      const raw = rest[++i];
      if (!raw || raw.startsWith("--")) return { badUsage: "--out requires a directory argument" };
      outDir = raw;
    } else if (a.startsWith("--")) {
      return { badUsage: `Unknown flag: ${a}` };
    } else if (specPath === undefined) {
      specPath = a;
    } else {
      return { badUsage: `Unexpected extra argument: ${a}` };
    }
  }
  if (specPath === undefined) return { badUsage: `${verb} requires a <spec-path> argument` };
  return { specPath, outDir };
}

function cmdEmit(deps: FactoryDeps, rest: string[]): number {
  const parsed = parseEmitArgs(rest);
  if ("badUsage" in parsed) {
    deps.error(`${parsed.badUsage}. ${USAGE}`);
    return 2;
  }
  const { specPath } = parsed;

  if (!deps.exists(specPath)) {
    deps.error(`No process spec found at ${specPath} — nothing emitted.`);
    return 1;
  }

  let spec;
  try {
    spec = loadProcessSpec(deps.readFile(specPath));
  } catch (e) {
    deps.error(`Failed to load process spec ${specPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // Mechanical validation gate (Task 2): a spec that fails a validator must
  // never emit — an orphan artifact or lying knob would ship as provenance.
  const failed = failures(validateProcessSpec(spec));
  if (failed.length > 0) {
    deps.error(`Spec ${specPath} failed mechanical validation — refusing to emit:`);
    for (const f of failed) deps.error(`  - ${f.criterionId}: ${f.evidence}`);
    return 1;
  }

  const outDir = parsed.outDir ?? path.join("packages", `${spec.meta.name}-pack`);
  try {
    const emitted = emitProcessPack(spec, outDir, { fs: deps.emitFs });
    const fileCount = renderPack(spec).length; // deterministic re-render, count only
    deps.log(`Emitted process pack: ${emitted} (${fileCount} file(s))`);
    return 0;
  } catch (e) {
    deps.error(`Emit failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// emit-grok
// ---------------------------------------------------------------------------

function cmdEmitGrok(deps: FactoryDeps, rest: string[]): number {
  const parsed = parseEmitArgs(rest, "emit-grok");
  if ("badUsage" in parsed) {
    deps.error(`${parsed.badUsage}. ${USAGE}`);
    return 2;
  }
  const { specPath } = parsed;

  if (!deps.exists(specPath)) {
    deps.error(`No process spec found at ${specPath} — nothing emitted.`);
    return 1;
  }

  let spec;
  try {
    spec = loadProcessSpec(deps.readFile(specPath));
  } catch (e) {
    deps.error(`Failed to load process spec ${specPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // Same mechanical validation gate as emit: refuse to ship invalid provenance.
  const failed = failures(validateProcessSpec(spec));
  if (failed.length > 0) {
    deps.error(`Spec ${specPath} failed mechanical validation — refusing to emit-grok:`);
    for (const f of failed) deps.error(`  - ${f.criterionId}: ${f.evidence}`);
    return 1;
  }

  const outDir =
    parsed.outDir ?? path.join("packages", `grok-pack-${spec.meta.name}-v${spec.meta.version}`);
  try {
    const emitted = emitGrokPack(spec, outDir, { fs: deps.emitFs });
    const fileCount = renderGrokPack(spec).length;
    deps.log(`Emitted Grok pack: ${emitted} (${fileCount} file(s))`);
    return 0;
  } catch (e) {
    deps.error(`Emit-grok failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

function parseDeployArgs(rest: string[]): { packDir: string; engramRoot?: string } | { badUsage: string } {
  let packDir: string | undefined;
  let engramRoot: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--engram-root") {
      const raw = rest[++i];
      if (!raw || raw.startsWith("--")) return { badUsage: "--engram-root requires a directory argument" };
      engramRoot = raw;
    } else if (a.startsWith("--")) {
      return { badUsage: `Unknown flag: ${a}` };
    } else if (packDir === undefined) {
      packDir = a;
    } else {
      return { badUsage: `Unexpected extra argument: ${a}` };
    }
  }
  if (packDir === undefined) return { badUsage: "deploy requires a <pack-dir> argument" };
  return { packDir, engramRoot };
}

async function cmdDeploy(deps: FactoryDeps, rest: string[]): Promise<number> {
  const parsed = parseDeployArgs(rest);
  if ("badUsage" in parsed) {
    deps.error(`${parsed.badUsage}. ${USAGE}`);
    return 2;
  }

  const engramPluginsRoot = parsed.engramRoot ?? deps.engramPluginsRoot;
  if (!engramPluginsRoot) {
    deps.error(
      "No engram-plugins checkout configured: pass --engram-root <dir> or set FACTORY_ENGRAM_PLUGINS_ROOT."
    );
    return 1;
  }

  try {
    const report = await deployProcessPack(parsed.packDir, {
      engramPluginsRoot,
      exec: deps.exec,
      fs: deps.deployFs,
    });
    deps.log(`Deployed ${parsed.packDir} on branch ${report.branch}`);
    deps.log(`Draft PR: ${report.prUrl}`);
    deps.log(`Conflict check: ${report.conflictCheck}`);
    return 0;
  } catch (e) {
    deps.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

interface ScanArgs {
  specPath: string;
  outcomesPath: string;
  minSample?: number;
  outPath?: string;
}

function parseScanArgs(rest: string[]): ScanArgs | { badUsage: string } {
  let specPath: string | undefined;
  let outcomesPath: string | undefined;
  let minSample: number | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--spec") {
      const raw = rest[++i];
      if (!raw || raw.startsWith("--")) return { badUsage: "--spec requires a file argument" };
      specPath = raw;
    } else if (a === "--outcomes") {
      const raw = rest[++i];
      if (!raw || raw.startsWith("--")) return { badUsage: "--outcomes requires a file argument" };
      outcomesPath = raw;
    } else if (a === "--min-sample") {
      const raw = rest[++i];
      if (!raw || raw.startsWith("--")) return { badUsage: "--min-sample requires a number argument" };
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        return { badUsage: `--min-sample must be a non-negative integer, got: ${raw}` };
      }
      minSample = n;
    } else if (a === "--out") {
      const raw = rest[++i];
      if (!raw || raw.startsWith("--")) return { badUsage: "--out requires a file argument" };
      outPath = raw;
    } else if (a.startsWith("--")) {
      return { badUsage: `Unknown flag: ${a}` };
    } else {
      return { badUsage: `Unexpected positional argument: ${a}` };
    }
  }
  if (specPath === undefined) return { badUsage: "scan requires --spec <spec-path>" };
  if (outcomesPath === undefined) return { badUsage: "scan requires --outcomes <dump-path>" };
  return { specPath, outcomesPath, minSample, outPath };
}

function printProposal(deps: FactoryDeps, proposal: ImprovementProposal): void {
  deps.log(`Verdict: ${proposal.verdict} — ${proposal.packName} (spec version ${proposal.targetSpecVersion})`);
  deps.log(`Summary: ${proposal.summary}`);
  if (proposal.specDiff.length > 0) {
    deps.log("Spec diff:");
    for (const d of proposal.specDiff) {
      deps.log(`  - ${d.path}: ${String(d.from)} -> ${String(d.to)}`);
      deps.log(`    rationale: ${d.rationale}`);
    }
  }
  deps.log("Evidence:");
  for (const e of proposal.evidence) deps.log(`  - ${e}`);
  // Invariant 5: a non-converged proposal carries its ESCALATION in evidence —
  // repeat it loudly on stderr so it cannot scroll past unnoticed.
  for (const e of proposal.evidence) {
    if (e.startsWith("ESCALATION")) deps.error(`  !! ${e}`);
  }
}

async function cmdScan(deps: FactoryDeps, rest: string[]): Promise<number> {
  const parsed = parseScanArgs(rest);
  if ("badUsage" in parsed) {
    deps.error(`${parsed.badUsage}. ${USAGE}`);
    return 2;
  }
  if (!deps.llm) {
    deps.error("scan requires an LLM, and none is configured in FactoryDeps.");
    return 1;
  }

  if (!deps.exists(parsed.specPath)) {
    deps.error(`No process spec found at ${parsed.specPath} — nothing scanned.`);
    return 1;
  }
  if (!deps.exists(parsed.outcomesPath)) {
    deps.error(`No outcome dump found at ${parsed.outcomesPath} — nothing scanned.`);
    return 1;
  }

  let spec;
  try {
    spec = loadProcessSpec(deps.readFile(parsed.specPath));
  } catch (e) {
    deps.error(`Failed to load process spec ${parsed.specPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // Mechanical validation gate (mirrors cmdEmit): a spec that fails a
  // validator must never be scanned — an orphan artifact would ground a
  // proposal in unjustified surface, and a lying knob default (pv-knob-bounds)
  // would corrupt the sample floor the minimum-sample rule depends on.
  const failed = failures(validateProcessSpec(spec));
  if (failed.length > 0) {
    deps.error(`Spec ${parsed.specPath} failed mechanical validation — refusing to scan:`);
    for (const f of failed) deps.error(`  - ${f.criterionId}: ${f.evidence}`);
    return 1;
  }

  let outcomes;
  try {
    outcomes = readOutcomes(deps.readFile(parsed.outcomesPath));
  } catch (e) {
    deps.error(
      `Failed to read outcome dump ${parsed.outcomesPath}: ${e instanceof Error ? e.message : String(e)}`
    );
    return 1;
  }

  let proposal: ImprovementProposal;
  try {
    proposal = await scanPack(
      deps.llm,
      spec,
      outcomes,
      parsed.minSample !== undefined ? { minSample: parsed.minSample } : {}
    );
  } catch (e) {
    deps.error(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  printProposal(deps, proposal);

  if (proposal.verdict === "propose") {
    if (parsed.outPath) {
      deps.emitFs.ensureDirSync(path.dirname(parsed.outPath));
      deps.emitFs.writeFileSync(parsed.outPath, JSON.stringify(proposal, null, 2) + "\n");
      deps.log(`Proposal JSON written to ${parsed.outPath}.`);
    }
    deps.log(
      "Proposal written for operator review — NEVER auto-applied (D-044). " +
        "Apply through the needs-review queue and a re-compilation, not by hand-editing a deployed pack."
    );
  }
  // insufficient_data and healthy are clean outcomes: the reason is in the
  // summary/evidence above (minimum-sample rule / zero defects). Exit 0.
  return 0;
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

/* istanbul ignore next -- network default; tests always inject deps.fetchJson */
const defaultFetchJson = async (
  url: string,
  headers: Record<string, string>
): Promise<unknown> => {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
};

/**
 * Family heuristic: the prefix before the first "/" when the id is namespaced
 * ("openai/gpt-4.1" → "openai", "meta-llama/Llama-3" → "meta-llama"); else the
 * prefix before the first "-" ("grok-4.5" → "grok", "claude-sonnet-5" →
 * "claude"); an id with neither separator is its own family.
 */
function modelFamily(id: string): string {
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash);
  const dash = id.indexOf("-");
  if (dash > 0) return id.slice(0, dash);
  return id;
}

async function cmdModels(deps: FactoryDeps, rest: string[]): Promise<number> {
  if (rest.length > 0) {
    deps.error(`models takes no arguments, got: ${rest[0]}. ${USAGE}`);
    return 2;
  }

  const cfg = resolveProviderConfig();

  if (cfg.provider === "claude" || cfg.provider === "anthropic") {
    // The Agent SDK has no OpenAI-style /models listing endpoint; model ids
    // are resolved internally (local claude login or ANTHROPIC_API_KEY).
    deps.log(`Provider: ${cfg.provider} (Claude Agent SDK)`);
    deps.log(
      "The Agent SDK resolves models internally — there is no listing endpoint to query. " +
        `Set PRINCIPLES_MODEL to pin a model (current: ${cfg.model}).`
    );
    return 0;
  }

  if (!cfg.apiKey) {
    deps.error(
      `No API key configured for provider "${cfg.provider}" — cannot query ${cfg.baseURL}/models. ` +
        "Set the provider's key (XAI_API_KEY / OPENAI_API_KEY / PRINCIPLES_API_KEY)."
    );
    return 1;
  }

  const url = `${cfg.baseURL}/models`;
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  let body: unknown;
  try {
    body = await fetchJson(url, { Authorization: `Bearer ${cfg.apiKey}` });
  } catch (e) {
    deps.error(`Failed to list models from ${url}: ${e instanceof Error ? e.message : String(e)}`);
    deps.error(
      "Hint: check that the endpoint is up (LiteLLM proxy running? PRINCIPLES_BASE_URL correct?) and the key is valid."
    );
    return 1;
  }

  // OpenAI listing shape: { data: [{ id, owned_by? }] }.
  const data = (body as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) {
    deps.error(`Unexpected response shape from ${url}: expected OpenAI-style { data: [{ id }] }.`);
    return 1;
  }
  const ids = data
    .map((d) => (d && typeof d === "object" ? (d as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");

  deps.log(`Provider: ${cfg.provider}  base URL: ${cfg.baseURL}  (${ids.length} model(s))`);

  const families = new Map<string, string[]>();
  for (const id of ids) {
    const family = modelFamily(id);
    const bucket = families.get(family);
    if (bucket) bucket.push(id);
    else families.set(family, [id]);
  }

  // Selection marker keys off the EXPLICIT env choice (PRINCIPLES_MODEL), not
  // the provider default — an unset env means nothing is "selected" to mark.
  const selected = process.env.PRINCIPLES_MODEL;
  for (const family of [...families.keys()].sort()) {
    deps.log(`${family}:`);
    for (const id of [...families.get(family)!].sort()) {
      deps.log(`  ${id}${id === selected ? " * (selected)" : ""}`);
    }
  }
  if (selected && !ids.includes(selected)) {
    deps.log(
      `Note: PRINCIPLES_MODEL="${selected}" is not in the listing — selected model not visible to this key.`
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function run(argv: string[], deps: FactoryDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "compile":
      return cmdCompile(deps, rest);
    case "emit":
      return cmdEmit(deps, rest);
    case "emit-grok":
      return cmdEmitGrok(deps, rest);
    case "deploy":
      return cmdDeploy(deps, rest);
    case "scan":
      return cmdScan(deps, rest);
    case "models":
      return cmdModels(deps, rest);
    default:
      deps.error(`Unknown subcommand: ${cmd ?? "(none)"}. ${USAGE}`);
      return 2;
  }
}

/* istanbul ignore next -- thin binding, covered by the wrapper-v0 milestone check */
if (require.main === module) {
  const realExec: ExecFn = (cmd, args, cwd) =>
    new Promise((resolve) => {
      execFile(cmd, args, { cwd }, (error, stdout, stderr) => {
        const raw = (error as { code?: number | string } | null)?.code;
        resolve({ code: error ? (typeof raw === "number" ? raw : 1) : 0, stdout, stderr });
      });
    });
  // The gateway resolves lazily on the FIRST model call so the deterministic
  // verbs (emit, emit-grok, deploy) stay usable offline with no key and no provider
  // warnings — compile and scan pay the resolution cost when they actually
  // need a model.
  let resolvedLlm: Llm | undefined;
  const lazyLlm: Llm = <T>(req: LlmRequest<T>): Promise<T> => {
    if (!resolvedLlm) resolvedLlm = resolveDefaultLlm();
    return resolvedLlm(req);
  };
  const deps: FactoryDeps = {
    readFile: (p) => fs.readFileSync(path.resolve(p), "utf8"),
    exists: (p) => fs.existsSync(path.resolve(p)),
    emitFs: fs,
    deployFs: {
      readFile: (p) => fs.readFileSync(p, "utf8"),
      writeFile: (p, data) => fs.outputFileSync(p, data),
      exists: (p) => fs.existsSync(p),
      copyDir: (from, to) => fs.copySync(from, to),
      listDirs: (p) =>
        fs.existsSync(p)
          ? fs
              .readdirSync(p, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
          : [],
    },
    exec: realExec,
    engramPluginsRoot: process.env.FACTORY_ENGRAM_PLUGINS_ROOT,
    llm: lazyLlm,
    webSurvey: providerSupportsWebTools(),
    // No live Engram client is wired yet; --engram degrades gracefully with a
    // warning (design §9: Engram unreachable never fails the run).
    log: console.log,
    error: console.error,
  };
  run(process.argv.slice(2), deps)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    });
}
