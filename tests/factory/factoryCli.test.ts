import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "path";
import { run, FactoryDeps } from "../../src/scripts/factoryCli";
import { EmitFs } from "../../src/factory/emitters/processPack";
import { ProcessSpec } from "../../src/factory/types";

const seedPath = path.join(__dirname, "..", "..", "seeds", "factory-meta", "process-spec.json");
const seedJson = fs.readFileSync(seedPath, "utf8");

/**
 * In-memory EmitFs: records writes, supports the emitter's temp-dir + rename
 * protocol so emitted packs land at their final paths in `files`.
 */
function makeFakeEmitFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const withSep = (p: string) => (p.endsWith(path.sep) ? p : p + path.sep);

  const emitFs: EmitFs = {
    existsSync: (p) =>
      files.has(p) || dirs.has(p) || [...files.keys(), ...dirs].some((k) => k.startsWith(withSep(p))),
    ensureDirSync: (p) => {
      dirs.add(p);
    },
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
    renameSync: (from, to) => {
      for (const [k, v] of [...files]) {
        if (k === from || k.startsWith(withSep(from))) {
          files.delete(k);
          files.set(to + k.slice(from.length), v);
        }
      }
      for (const d of [...dirs]) {
        if (d === from || d.startsWith(withSep(from))) {
          dirs.delete(d);
          dirs.add(to + d.slice(from.length));
        }
      }
    },
    removeSync: (p) => {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(withSep(p))) files.delete(k);
      for (const d of [...dirs]) if (d === p || d.startsWith(withSep(p))) dirs.delete(d);
    },
  };
  return { files, dirs, emitFs };
}

/** Deps with a spec-file world (readFile/exists) separate from the emit fs. */
const makeDeps = (specFiles: Record<string, string> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const specs = new Map(Object.entries(specFiles));
  const fake = makeFakeEmitFs();
  const deps: FactoryDeps = {
    readFile: (p) => {
      const content = specs.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    exists: (p) => specs.has(p),
    emitFs: fake.emitFs,
    log: (s) => out.push(s),
    error: (s) => err.push(s),
  };
  return { deps, out, err, fake };
};

describe("factory emit", () => {
  it("emits the seed spec's pack to --out with the key paths present and logs path + file count", async () => {
    const { deps, out, fake } = makeDeps({ "seed.json": seedJson });

    const code = await run(["emit", "seed.json", "--out", path.join("out", "pack")], deps);

    expect(code).toBe(0);
    const emitted = [...fake.files.keys()].sort();
    expect(emitted).toEqual(
      [
        path.join("out", "pack", ".claude-plugin", "plugin.json"),
        path.join("out", "pack", "gates", "spec-approval-gate.md"),
        path.join("out", "pack", "hooks", "deploy-discipline-hook.md"),
        path.join("out", "pack", "manifest", "forge-handoff.json"),
        path.join("out", "pack", "manifest", "metrics.json"),
        path.join("out", "pack", "process-spec.json"),
        path.join("out", "pack", "skills", "factory-intake", "SKILL.md"),
      ].sort()
    );
    // Embedded spec round-trips and the success line carries path + count.
    expect(JSON.parse(fake.files.get(path.join("out", "pack", "process-spec.json"))!).meta.name).toBe(
      "process-factory-meta"
    );
    expect(out.join("\n")).toContain(path.join("out", "pack"));
    expect(out.join("\n")).toContain("7 file(s)");
  });

  it("defaults the output directory to packages/<spec.meta.name>-pack", async () => {
    const { deps, fake } = makeDeps({ "seed.json": seedJson });

    const code = await run(["emit", "seed.json"], deps);

    expect(code).toBe(0);
    const defaultRoot = path.join("packages", "process-factory-meta-pack");
    expect(fake.files.has(path.join(defaultRoot, "process-spec.json"))).toBe(true);
    expect(fake.files.has(path.join(defaultRoot, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("a spec failing a mechanical validator exits 1, prints the failing criterion, and emits nothing", async () => {
    const spec = JSON.parse(seedJson) as ProcessSpec;
    spec.artifacts[0].traceability = { truthIds: [], constraintIds: [] }; // orphan → pv-traceability
    const { deps, err, fake } = makeDeps({ "bad.json": JSON.stringify(spec) });

    const code = await run(["emit", "bad.json"], deps);

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("pv-traceability");
    expect(err.join("\n")).toContain(spec.artifacts[0].name); // offender evidence surfaced
    expect(fake.files.size).toBe(0);
  });

  it("a missing spec file exits 1 with a readable error naming the path", async () => {
    const { deps, err, fake } = makeDeps();

    const code = await run(["emit", "nope/spec.json"], deps);

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("nope/spec.json");
    expect(fake.files.size).toBe(0);
  });

  it("a spec that fails shape validation (not valid ProcessSpec JSON) exits 1 with the loader's error", async () => {
    const { deps, err, fake } = makeDeps({ "mangled.json": '{"meta": {}}' });

    const code = await run(["emit", "mangled.json"], deps);

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("mangled.json");
    expect(err.join("\n")).toContain("Invalid process spec");
    expect(fake.files.size).toBe(0);
  });

  it("emit without a spec path is a usage error (exit 2)", async () => {
    const { deps, err } = makeDeps();

    const code = await run(["emit"], deps);

    expect(code).toBe(2);
    expect(err.join("\n")).toContain("Usage:");
  });

  it("an unknown flag on emit is a usage error (exit 2), nothing emitted", async () => {
    const { deps, err, fake } = makeDeps({ "seed.json": seedJson });

    const code = await run(["emit", "seed.json", "--bogus"], deps);

    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--bogus");
    expect(fake.files.size).toBe(0);
  });
});

describe("factory verbs", () => {
  it("compile exits 2 with a not-yet-implemented message naming Task 7", async () => {
    const { deps, err } = makeDeps();
    expect(await run(["compile", "some problem"], deps)).toBe(2);
    expect(err.join("\n")).toContain("not yet implemented (Task 7)");
  });

  it("scan exits 2 with a not-yet-implemented message naming Task 10", async () => {
    const { deps, err } = makeDeps();
    expect(await run(["scan"], deps)).toBe(2);
    expect(err.join("\n")).toContain("not yet implemented (Task 10)");
  });

  it("an unknown subcommand exits 2 with usage", async () => {
    const { deps, err } = makeDeps();
    expect(await run(["frobnicate"], deps)).toBe(2);
    expect(err.join("\n")).toContain("Unknown subcommand: frobnicate");
    expect(err.join("\n")).toContain("Usage:");
  });

  it("no subcommand at all exits 2 with usage", async () => {
    const { deps, err } = makeDeps();
    expect(await run([], deps)).toBe(2);
    expect(err.join("\n")).toContain("(none)");
  });
});
