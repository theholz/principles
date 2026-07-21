import path from "path";
import { execFile } from "child_process";
import fs from "fs-extra";
import { failures } from "../shared/types";
import { loadProcessSpec } from "../factory/loadSpec";
import { validateProcessSpec } from "../factory/validators";
import { emitProcessPack, renderPack, EmitFs } from "../factory/emitters/processPack";
import { deployProcessPack, DeployFs, ExecFn } from "../factory/deploy";

/**
 * Process-factory CLI (design §7): `factory compile | emit | deploy | scan`.
 * The deterministic `emit` verb and the `deploy` verb (Task 9: branch + draft
 * PR only) are live — compile (Task 7) and scan (Task 10) land with their
 * stages. Deliberately LLM-free: nothing here imports src/llm, so emit and
 * deploy work offline with no key at all. Convention mirrors
 * src/scripts/researchPilot.ts: run(argv, deps) with injected FactoryDeps,
 * switch(cmd), require.main binding at the bottom.
 *
 * Exit codes: 0 success · 1 operational failure (missing/invalid spec,
 * validator failure, emit/deploy refusal, missing engram-plugins root) ·
 * 2 usage error (unknown verb/flag, not-yet-implemented verb).
 */

export interface FactoryDeps {
  readFile: (p: string) => string;
  exists: (p: string) => boolean;
  /** Filesystem surface handed to emitProcessPack (fs-extra in production). */
  emitFs: EmitFs;
  /** Filesystem surface handed to deployProcessPack (fs-extra in production). */
  deployFs: DeployFs;
  /** Child-process capability for deploy (real child_process in production). */
  exec: ExecFn;
  /** Default engram-plugins checkout (env FACTORY_ENGRAM_PLUGINS_ROOT); --engram-root overrides. */
  engramPluginsRoot?: string;
  log: (s: string) => void;
  error: (s: string) => void;
}

const USAGE =
  'Usage: factory emit <spec-path> [--out <dir>] | deploy <pack-dir> [--engram-root <dir>] | compile "<problem>" | scan';

function parseEmitArgs(rest: string[]): { specPath: string; outDir?: string } | { badUsage: string } {
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
  if (specPath === undefined) return { badUsage: "emit requires a <spec-path> argument" };
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

export async function run(argv: string[], deps: FactoryDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "emit":
      return cmdEmit(deps, rest);
    case "deploy":
      return cmdDeploy(deps, rest);
    case "compile":
      deps.error(`"compile" is not yet implemented (Task 7). ${USAGE}`);
      return 2;
    case "scan":
      deps.error(`"scan" is not yet implemented (Task 10). ${USAGE}`);
      return 2;
    default:
      deps.error(`Unknown subcommand: ${cmd ?? "(none)"}. ${USAGE}`);
      return 2;
  }
}

/* istanbul ignore next -- thin binding, covered by the wrapper-v0 milestone check */
if (require.main === module) {
  // No LLM layer here on purpose: emit and deploy are deterministic and must
  // stay usable offline. compile wires in resolveDefaultLlm when it lands (Task 7).
  const realExec: ExecFn = (cmd, args, cwd) =>
    new Promise((resolve) => {
      execFile(cmd, args, { cwd }, (error, stdout, stderr) => {
        const raw = (error as { code?: number | string } | null)?.code;
        resolve({ code: error ? (typeof raw === "number" ? raw : 1) : 0, stdout, stderr });
      });
    });
  const deps: FactoryDeps = {
    readFile: (p) => fs.readFileSync(path.resolve(p), "utf8"),
    exists: (p) => fs.existsSync(path.resolve(p)),
    emitFs: fs,
    deployFs: {
      readFile: (p) => fs.readFileSync(p, "utf8"),
      writeFile: (p, data) => fs.outputFileSync(p, data),
      exists: (p) => fs.existsSync(p),
      copyDir: (from, to) => fs.copySync(from, to),
    },
    exec: realExec,
    engramPluginsRoot: process.env.FACTORY_ENGRAM_PLUGINS_ROOT,
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
