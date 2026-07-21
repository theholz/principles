import { describe, it, expect } from "vitest";
import path from "path";
import {
  deployProcessPack,
  DeployFs,
  ExecFn,
  ExecResult,
  FactoryRegistryEntry,
  CONFLICT_CHECK_RELPATH,
  REGISTRY_FILENAME,
} from "../../src/factory/deploy";

/**
 * Network-free, subprocess-free: the injected exec records every (cmd, args,
 * cwd) and replies from a script; the injected fs is a Map. The assertions
 * pin the exact git/gh conversation — the whole point of Task 9 is that the
 * deploy module knows ONLY the branch + draft-PR path (design §10).
 */

const ROOT = path.join("/", "checkout", "engram-plugins");
const PACK = path.join("/", "packs", "demo-pack");
const NOW = new Date("2026-07-21T12:00:00.000Z");
const BRANCH = "factory/deploy-demo-pack-2026-07-21T12-00-00-000Z";
const CONFLICT_SCRIPT = path.join(ROOT, CONFLICT_CHECK_RELPATH);
const DEST = path.join(ROOT, "plugins", "demo-pack", "0.1.0");

const packFiles = (): Record<string, string> => ({
  [path.join(PACK, ".claude-plugin", "plugin.json")]: JSON.stringify({
    name: "demo-pack",
    version: "0.1.0",
  }),
  [path.join(PACK, "process-spec.json")]: JSON.stringify({ meta: { version: "0.1.0" } }),
  [path.join(PACK, "manifest", "metrics.json")]: JSON.stringify({ governancePhase: "shadow" }),
});

interface RecordedCall {
  cmd: string;
  args: string[];
  cwd?: string;
}

function makeWorld(opts: {
  files?: Record<string, string>;
  /** Return a scripted result for a call (matched first), or undefined for the default success. */
  script?: (call: RecordedCall) => ExecResult | undefined;
}) {
  const files = new Map(Object.entries(opts.files ?? packFiles()));
  const copies: { from: string; to: string }[] = [];
  const calls: RecordedCall[] = [];

  const fs: DeployFs = {
    readFile: (p) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    },
    writeFile: (p, data) => {
      files.set(p, data);
    },
    exists: (p) => files.has(p),
    copyDir: (from, to) => {
      copies.push({ from, to });
      // Model the copy: source files land under the destination.
      for (const [k, v] of [...files]) {
        if (k.startsWith(from + path.sep)) files.set(to + k.slice(from.length), v);
      }
    },
  };

  const exec: ExecFn = async (cmd, args, cwd) => {
    const call = { cmd, args, cwd };
    calls.push(call);
    return opts.script?.(call) ?? { code: 0, stdout: "", stderr: "" };
  };

  return { fs, exec, files, copies, calls };
}

const deploy = (world: ReturnType<typeof makeWorld>) =>
  deployProcessPack(PACK, { engramPluginsRoot: ROOT, exec: world.exec, fs: world.fs, now: () => NOW });

const registry = (world: ReturnType<typeof makeWorld>): FactoryRegistryEntry[] =>
  JSON.parse(world.files.get(path.join(ROOT, REGISTRY_FILENAME))!);

describe("deployProcessPack", () => {
  it("runs the exact git/gh sequence — branch, add only its paths, commit, push -u origin, draft PR — all in the checkout", async () => {
    const world = makeWorld({
      files: { ...packFiles(), [CONFLICT_SCRIPT]: "#!/usr/bin/env python3" },
      script: (c) =>
        c.cmd === "gh"
          ? { code: 0, stdout: "https://github.com/theholz/engram-plugins/pull/42\n", stderr: "" }
          : undefined,
    });

    const report = await deploy(world);

    expect(world.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual([
      `git checkout -b ${BRANCH}`,
      `python3 ${CONFLICT_SCRIPT} ${path.join(DEST, "skills")}`,
      `git add -- ${path.join("plugins", "demo-pack", "0.1.0")} ${REGISTRY_FILENAME}`,
      "git commit -m factory deploy: demo-pack@0.1.0",
      `git push -u origin ${BRANCH}`,
      expect.stringMatching(/^gh pr create --draft --title factory deploy: demo-pack@0\.1\.0 --body /),
    ]);
    // Every exec runs against the engram-plugins checkout, nowhere else.
    expect(world.calls.every((c) => c.cwd === ROOT)).toBe(true);
    // The report's command log matches what actually ran.
    expect(report.commands).toEqual(world.calls.map((c) => [c.cmd, ...c.args].join(" ")));
    expect(report.branch).toBe(BRANCH);
    expect(report.prUrl).toBe("https://github.com/theholz/engram-plugins/pull/42");
    // The pack is copied to plugins/<name>/<version>/ inside the checkout.
    expect(world.copies).toEqual([{ from: PACK, to: DEST }]);
    // No command ever touches main: the only push is -u origin <branch>.
    const pushes = world.calls.filter((c) => c.cmd === "git" && c.args[0] === "push");
    expect(pushes).toEqual([{ cmd: "git", args: ["push", "-u", "origin", BRANCH], cwd: ROOT }]);
    expect(world.calls.some((c) => c.args.includes("merge") || c.args.includes("main"))).toBe(false);
  });

  it("conflict check present: python3 runs and its stdout summary lands in the PR body", async () => {
    const world = makeWorld({
      files: { ...packFiles(), [CONFLICT_SCRIPT]: "#!/usr/bin/env python3" },
      script: (c) =>
        c.cmd === "python3" ? { code: 0, stdout: "0 conflicts across 12 skills\n", stderr: "" } : undefined,
    });

    const report = await deploy(world);

    expect(report.conflictCheck).toBe("ran");
    expect(world.calls.some((c) => c.cmd === "python3")).toBe(true);
    const gh = world.calls.find((c) => c.cmd === "gh")!;
    const body = gh.args[gh.args.indexOf("--body") + 1];
    expect(body).toContain("## Conflict check");
    expect(body).toContain("0 conflicts across 12 skills");
    expect(body).not.toContain("SKIPPED");
  });

  it("conflict check absent: no python3 call, deploy succeeds, SKIPPED note in the PR body", async () => {
    const world = makeWorld({}); // no conflict_check.py in the checkout

    const report = await deploy(world);

    expect(report.conflictCheck).toBe("skipped");
    expect(world.calls.some((c) => c.cmd === "python3")).toBe(false);
    const gh = world.calls.find((c) => c.cmd === "gh")!;
    const body = gh.args[gh.args.indexOf("--body") + 1];
    expect(body).toContain("conflict check: SKIPPED (conflict_check.py not found");
  });

  it("conflict check exec failure: deploy still succeeds with a SKIPPED note carrying the reason", async () => {
    const world = makeWorld({
      files: { ...packFiles(), [CONFLICT_SCRIPT]: "#!/usr/bin/env python3" },
      script: (c) => (c.cmd === "python3" ? { code: 3, stdout: "", stderr: "boom" } : undefined),
    });

    const report = await deploy(world);

    expect(report.conflictCheck).toBe("skipped");
    const gh = world.calls.find((c) => c.cmd === "gh")!;
    const body = gh.args[gh.args.indexOf("--body") + 1];
    expect(body).toContain("conflict check: SKIPPED (conflict_check.py exited 3: boom)");
  });

  it("the PR body names pack, version, and the metrics manifest's governancePhase", async () => {
    const world = makeWorld({});

    await deploy(world);

    const gh = world.calls.find((c) => c.cmd === "gh")!;
    expect(gh.args).toContain("--draft");
    const body = gh.args[gh.args.indexOf("--body") + 1];
    expect(body).toContain("demo-pack@0.1.0");
    expect(body).toContain("`shadow`");
  });

  it("a pack missing manifest/metrics.json is refused before ANY exec call", async () => {
    const files = packFiles();
    delete files[path.join(PACK, "manifest", "metrics.json")];
    const world = makeWorld({ files });

    await expect(deploy(world)).rejects.toThrow(/Refusing to deploy.*metrics\.json/);
    expect(world.calls).toEqual([]);
    expect(world.copies).toEqual([]);
  });

  it("a pack missing .claude-plugin/plugin.json or process-spec.json is likewise refused pre-exec", async () => {
    for (const missing of [path.join(".claude-plugin", "plugin.json"), "process-spec.json"]) {
      const files = packFiles();
      delete files[path.join(PACK, missing)];
      const world = makeWorld({ files });
      await expect(deploy(world)).rejects.toThrow(/Refusing to deploy/);
      expect(world.calls).toEqual([]);
    }
  });

  it("a git push failure is a hard error naming the failing command", async () => {
    const world = makeWorld({
      script: (c) =>
        c.cmd === "git" && c.args[0] === "push" ? { code: 128, stdout: "", stderr: "remote hung up" } : undefined,
    });

    await expect(deploy(world)).rejects.toThrow(
      `Deploy failed: command "git push -u origin ${BRANCH}" exited 128 — remote hung up`
    );
    // The failure stops the deploy: no PR is ever opened.
    expect(world.calls.some((c) => c.cmd === "gh")).toBe(false);
  });

  it("creates factory-registry.json when absent, with the full entry", async () => {
    const world = makeWorld({});

    const report = await deploy(world);

    const entry: FactoryRegistryEntry = {
      name: "demo-pack",
      version: "0.1.0",
      specVersion: "0.1.0",
      deployedAt: "2026-07-21T12:00:00.000Z",
      target: "claude-code-plugin",
      metricsLocation: "plugins/demo-pack/0.1.0/manifest/metrics.json",
    };
    expect(registry(world)).toEqual([entry]);
    expect(report.registryEntry).toEqual(entry);
  });

  it("appends to an existing registry, preserving prior entries verbatim", async () => {
    const prior: FactoryRegistryEntry = {
      name: "other-pack",
      version: "2.0.0",
      specVersion: "2.0.0",
      deployedAt: "2026-01-01T00:00:00.000Z",
      target: "claude-code-plugin",
      metricsLocation: "plugins/other-pack/2.0.0/manifest/metrics.json",
    };
    const world = makeWorld({
      files: { ...packFiles(), [path.join(ROOT, REGISTRY_FILENAME)]: JSON.stringify([prior]) },
    });

    await deploy(world);

    const entries = registry(world);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(prior); // untouched, still first
    expect(entries[1].name).toBe("demo-pack");
  });

  it("re-deploying the same name@version replaces its entry in place instead of duplicating", async () => {
    const stale: FactoryRegistryEntry = {
      name: "demo-pack",
      version: "0.1.0",
      specVersion: "0.1.0",
      deployedAt: "2026-01-01T00:00:00.000Z",
      target: "claude-code-plugin",
      metricsLocation: "plugins/demo-pack/0.1.0/manifest/metrics.json",
    };
    const world = makeWorld({
      files: { ...packFiles(), [path.join(ROOT, REGISTRY_FILENAME)]: JSON.stringify([stale]) },
    });

    await deploy(world);

    const entries = registry(world);
    expect(entries).toHaveLength(1);
    expect(entries[0].deployedAt).toBe("2026-07-21T12:00:00.000Z");
  });

  it("an unparseable gh stdout yields prUrl 'unknown' without failing the deploy", async () => {
    const world = makeWorld({
      script: (c) => (c.cmd === "gh" ? { code: 0, stdout: "created, but no url printed", stderr: "" } : undefined),
    });

    const report = await deploy(world);

    expect(report.prUrl).toBe("unknown");
  });

  it("a corrupt existing registry is a hard error (history is never silently clobbered)", async () => {
    const world = makeWorld({
      files: { ...packFiles(), [path.join(ROOT, REGISTRY_FILENAME)]: "{not json" },
    });

    await expect(deploy(world)).rejects.toThrow(/factory-registry\.json is not valid JSON/);
  });

  it("a path-unsafe pack name is refused pre-exec (no traversal into the checkout)", async () => {
    const files = packFiles();
    files[path.join(PACK, ".claude-plugin", "plugin.json")] = JSON.stringify({
      name: "../evil",
      version: "0.1.0",
    });
    const world = makeWorld({ files });

    await expect(deploy(world)).rejects.toThrow(/not path\/ref-safe/);
    expect(world.calls).toEqual([]);
  });
});
