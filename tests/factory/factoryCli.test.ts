import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "path";
import { run, FactoryDeps } from "../../src/scripts/factoryCli";
import { EmitFs } from "../../src/factory/emitters/processPack";
import { ProcessSpec, Artifact } from "../../src/factory/types";
import { OutcomeRecord } from "../../src/factory/scan";
import { loadProcessSpec } from "../../src/factory/loadSpec";
import { Llm, LlmRequest } from "../../src/llm/gateway";

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

/**
 * Deps with a spec-file world (readFile/exists) separate from the emit fs.
 * The deploy surface (deployFs + exec) shares the same file map and records
 * every exec call — no real subprocess ever runs in these tests. compile and
 * scan take the injected fake `llm`; both write through the fake emit fs.
 */
const makeDeps = (
  specFiles: Record<string, string> = {},
  opts: {
    engramPluginsRoot?: string;
    llm?: Llm;
    webSurvey?: boolean;
    fetchJson?: FactoryDeps["fetchJson"];
  } = {}
) => {
  const out: string[] = [];
  const err: string[] = [];
  const specs = new Map(Object.entries(specFiles));
  const fake = makeFakeEmitFs();
  const execCalls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const deps: FactoryDeps = {
    readFile: (p) => {
      const content = specs.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    exists: (p) => specs.has(p),
    emitFs: fake.emitFs,
    deployFs: {
      readFile: (p) => {
        const content = specs.get(p);
        if (content === undefined) throw new Error(`ENOENT: ${p}`);
        return content;
      },
      writeFile: (p, data) => {
        specs.set(p, data);
      },
      exists: (p) => specs.has(p),
      copyDir: () => {},
      // No conflict script exists in these worlds, so the check skips before
      // ever listing skill dirs.
      listDirs: () => [],
    },
    exec: async (cmd, args, cwd) => {
      execCalls.push({ cmd, args, cwd });
      return cmd === "gh"
        ? { code: 0, stdout: "https://github.com/theholz/engram-plugins/pull/7\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    },
    engramPluginsRoot: opts.engramPluginsRoot,
    llm: opts.llm,
    webSurvey: opts.webSurvey,
    fetchJson: opts.fetchJson,
    log: (s) => out.push(s),
    error: (s) => err.push(s),
  };
  return { deps, out, err, fake, execCalls };
};

// ---------------------------------------------------------------------------
// Scripted fake LLMs (tests/factory/compile.test.ts and scan.test.ts patterns:
// dispatch on schemaName, record every request, per-stage overrides)
// ---------------------------------------------------------------------------

/** Criterion ids of whatever rubric the judge was handed, parsed from the prompt. */
function rubricIds(prompt: string): string[] {
  const section = prompt.split("## Rubric")[1] ?? "";
  return [...section.matchAll(/^- ([\w-]+):/gm)].map((m) => m[1]);
}

const passAll = (prompt: string) => ({
  verdicts: rubricIds(prompt).map((id) => ({
    criterionId: id,
    pass: true,
    evidence: `criterion ${id} satisfied by cited candidate content`,
  })),
});

const PROBLEM = "keep a disciplined daily trade journal with review gates";

const GATE_ARTIFACT: Artifact = {
  name: "trigger-citation-gate",
  kind: "gate",
  disposition: "forge_new",
  traceability: { truthIds: ["t1"], constraintIds: ["c1"] },
  l2Rationale:
    "a gate, not a skill: citation must be non-bypassable at entry time; a skill relies on recall and a hook fires too late",
  relationships: { dependsOn: [], complements: [], composesWith: [], supersedes: [], bindsTools: ["git"] },
};

/**
 * ONE scripted fake covering the FULL compile schemaName surface (replicated
 * from tests/factory/compile.test.ts fullPipelineLlm — same fixture responses,
 * proven there to assemble a validator-passing spec).
 */
function compilePipelineLlm(overrides: Partial<Record<string, (req: LlmRequest<unknown>) => unknown>> = {}) {
  const calls: LlmRequest<unknown>[] = [];
  const countBySchema = (name: string) => calls.filter((c) => c.schemaName === name).length;

  const llm = (async <T>(req: LlmRequest<T>) => {
    calls.push(req as LlmRequest<unknown>);
    const override = overrides[req.schemaName];
    if (override) return override(req as LlmRequest<unknown>);
    switch (req.schemaName) {
      case "capability_inventory":
        return {
          inventory: [
            { name: "dmaic", kind: "skill", location: "/plugins/methodologies/skills/dmaic", status: "partial" },
            { name: "journal-gate", kind: "hook", location: "", status: "gap" },
          ],
        };
      case "triage_verdict":
        return {
          verdict: "create_new",
          citedEntryIds: [],
          evidence: "dmaic is only partial; journal-gate is a gap — coverage below 50%",
        };
      case "constraint_analysis":
        return {
          flowSteps: ["capture", "review", "act"],
          statement: "manual review capacity limits throughput",
          type: "knowledge",
          exploitOptions: ["batch reviews"],
          subordinateOptions: ["queue captures to review pace"],
          elevateOptions: ["automate first-pass review"],
          evidence: "review is the only step with no built capability in the inventory",
        };
      case "truth_attack":
        return { verdict: "survives", strongestAttack: "none", justification: "solid" };
      case "landscape_survey":
        return { observations: [] };
      case "typed_truths":
        return {
          truths: [{ type: "constraint", statement: "every trade entry must cite its trigger", rationale: "r", groundedIn: [] }],
        };
      case "decomposition":
        return {
          subtasks: [
            { description: "capture and review each trade", servesTruths: ["t1"], dependsOnIndices: [], needsWeb: false, webJustification: "" },
          ],
          coverageMap: [{ dimension: "trade capture", handledBy: "1", exclusionReason: "" }],
        };
      case "frame_challenges":
        return { challenges: [] };
      case "process_contract":
        return {
          ctqs: [
            {
              persona: "trader",
              metric: "entries citing their trigger (serves t1)",
              specLimit: "100%",
              defectDefinition: "an entry with no cited trigger",
            },
          ],
          baseline: "unmeasured",
          baselineJustification: "",
          decisionRule: "any defect in a weekly window trips review",
          controlPlan: { monitoringCadence: "weekly", response: "open improvement proposal" },
        };
      case "agent_spec":
        return { name: "Journal keeper", instructions: "keep the journal, citing every trigger", outputHint: "journal entries" };
      case "artifact_plan":
        return { artifacts: [GATE_ARTIFACT] };
      case "rubric_verdicts":
        return passAll(req.prompt);
      default:
        throw new Error(`unexpected schema ${req.schemaName}`);
    }
  }) as unknown as Llm;

  return { llm, calls, countBySchema };
}

/** Scan fake (tests/factory/scan.test.ts pattern): proposal + passing judge. */
function scanScriptedLlm() {
  const calls: LlmRequest<unknown>[] = [];
  const countBySchema = (name: string) => calls.filter((c) => c.schemaName === name).length;
  const llm = (async <T>(req: LlmRequest<T>) => {
    calls.push(req as LlmRequest<unknown>);
    switch (req.schemaName) {
      case "improvement_proposal":
        return {
          summary: "Lower scanMinSampleSize default: ctq1 defects recur across consecutive windows",
          specDiff: [
            {
              path: "knobs.0.default",
              from: "20",
              to: "10",
              rationale: "records r1 and r2 show ctq1 defects in consecutive windows 2026-W1 and 2026-W2",
            },
          ],
          evidence: ["r1: ctq1 defect in window 2026-W1", "r2: ctq1 defect in window 2026-W2"],
        };
      case "rubric_verdicts":
        return {
          verdicts: [
            { criterionId: "ip-evidence", pass: true, evidence: "rationale cites r1 and r2 by label" },
            { criterionId: "ip-scope", pass: true, evidence: "only knobs.0.default is touched" },
          ],
        };
      default:
        throw new Error(`unexpected schema ${req.schemaName}`);
    }
  }) as unknown as Llm;
  return { llm, calls, countBySchema };
}

/** An Llm that counts calls and fails the test if any call reaches it. */
function forbiddenLlm() {
  let count = 0;
  const llm = (async () => {
    count += 1;
    throw new Error("LLM must not be called on a deterministic pre-check path");
  }) as unknown as Llm;
  return { llm, callCount: () => count };
}

/** n outcome records against the seed pack, distinct windows. */
const records = (n: number, over: Partial<OutcomeRecord> = {}): OutcomeRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    packName: "process-factory-meta",
    packVersion: "0.1.0",
    ctqId: "ctq1",
    window: `2026-W${i + 1}`,
    defect: false,
    evidence: "scan window clean",
    recordedAt: "2026-07-20T00:00:00Z",
    ...over,
  }));

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

describe("factory deploy", () => {
  const packDir = path.join("packs", "demo-pack");
  const packFiles = (): Record<string, string> => ({
    [path.join(packDir, ".claude-plugin", "plugin.json")]: JSON.stringify({
      name: "demo-pack",
      version: "0.1.0",
    }),
    [path.join(packDir, "process-spec.json")]: JSON.stringify({ meta: { version: "0.1.0" } }),
    [path.join(packDir, "manifest", "metrics.json")]: JSON.stringify({ governancePhase: "shadow" }),
  });

  it("deploys with --engram-root: exit 0, prints branch + draft-PR url, runs the git/gh sequence", async () => {
    const { deps, out, execCalls } = makeDeps(packFiles());

    const code = await run(["deploy", packDir, "--engram-root", "engram-plugins"], deps);

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("factory/deploy-demo-pack-");
    expect(out.join("\n")).toContain("https://github.com/theholz/engram-plugins/pull/7");
    const rendered = execCalls.map((c) => [c.cmd, ...c.args].join(" "));
    expect(rendered[0]).toMatch(/^git checkout -b factory\/deploy-demo-pack-/);
    expect(rendered).toContainEqual(expect.stringMatching(/^git push -u origin factory\/deploy-demo-pack-/));
    expect(rendered).toContainEqual(expect.stringMatching(/^gh pr create --draft /));
    expect(execCalls.every((c) => c.cwd === "engram-plugins")).toBe(true);
  });

  it("falls back to deps.engramPluginsRoot (env FACTORY_ENGRAM_PLUGINS_ROOT) when --engram-root is absent", async () => {
    const { deps, execCalls } = makeDeps(packFiles(), { engramPluginsRoot: "env-root" });

    const code = await run(["deploy", packDir], deps);

    expect(code).toBe(0);
    expect(execCalls.every((c) => c.cwd === "env-root")).toBe(true);
  });

  it("neither --engram-root nor the env root configured: exit 1, nothing executed", async () => {
    const { deps, err, execCalls } = makeDeps(packFiles());

    const code = await run(["deploy", packDir], deps);

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--engram-root");
    expect(err.join("\n")).toContain("FACTORY_ENGRAM_PLUGINS_ROOT");
    expect(execCalls).toEqual([]);
  });

  it("a pack missing manifest/metrics.json is refused: exit 1, no exec calls", async () => {
    const files = packFiles();
    delete files[path.join(packDir, "manifest", "metrics.json")];
    const { deps, err, execCalls } = makeDeps(files);

    const code = await run(["deploy", packDir, "--engram-root", "engram-plugins"], deps);

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Refusing to deploy");
    expect(execCalls).toEqual([]);
  });

  it("deploy without a pack dir is a usage error (exit 2)", async () => {
    const { deps, err } = makeDeps();
    expect(await run(["deploy"], deps)).toBe(2);
    expect(err.join("\n")).toContain("Usage:");
  });

  it("an unknown flag on deploy is a usage error (exit 2), nothing executed", async () => {
    const { deps, err, execCalls } = makeDeps(packFiles());
    expect(await run(["deploy", packDir, "--bogus"], deps)).toBe(2);
    expect(err.join("\n")).toContain("--bogus");
    expect(execCalls).toEqual([]);
  });
});

describe("factory compile", () => {
  it("happy path: exit 0, spec written to the default out path via the injected fs, HITL message printed", async () => {
    const { llm } = compilePipelineLlm();
    const { deps, out, err, fake } = makeDeps({}, { llm });

    const code = await run(["compile", PROBLEM], deps);

    expect(code).toBe(0);
    expect(err).toEqual([]); // no escalations, nothing on stderr

    // Default --out: process-spec.json in cwd, written through the injected fs
    // and round-tripping the strict loader.
    const written = fake.files.get("process-spec.json");
    expect(written).toBeDefined();
    const spec = loadProcessSpec(written!);
    expect(spec.meta.problemStatement).toBe(PROBLEM);
    expect(spec.artifacts).toEqual([GATE_ARTIFACT]);

    // The structural gate: compile stops at the spec, pointing at the separate
    // human-invoked emit step.
    const stdout = out.join("\n");
    expect(stdout).toContain("Spec: process-spec.json");
    expect(stdout).toContain("HITL: review the spec, then run `yarn factory emit process-spec.json`");
    // No pack was emitted — the only write is the spec itself.
    expect([...fake.files.keys()]).toEqual(["process-spec.json"]);
  });

  it("honors --out for the spec path", async () => {
    const { llm } = compilePipelineLlm();
    const { deps, out, fake } = makeDeps({}, { llm });
    const outPath = path.join("specs", "journal.json");

    const code = await run(["compile", PROBLEM, "--out", outPath], deps);

    expect(code).toBe(0);
    expect(fake.files.has(outPath)).toBe(true);
    expect(out.join("\n")).toContain(`yarn factory emit ${outPath}`);
  });

  it("build_nothing: exit 0, verdict + evidence printed, no spec written", async () => {
    // The CLI wires no injected id generator, so this exercises the default
    // crypto-derived opaque ids: the fake reads the id for dmaic off the
    // inventory table in its own prompt — exactly what a live model must do.
    const idOf = (prompt: string, name: string): string => {
      const m = prompt.match(new RegExp(`^- (\\S+): ${name} \\[`, "m"));
      if (!m) throw new Error(`no inventory id for ${name} in the triage prompt`);
      return m[1];
    };
    const { llm, countBySchema } = compilePipelineLlm({
      triage_verdict: (req) => ({
        verdict: "use_existing",
        citedEntryIds: [idOf(req.prompt, "dmaic")],
        evidence: "dmaic covers >=80% of the need",
      }),
    });
    const { deps, out, fake } = makeDeps({}, { llm });

    const code = await run(["compile", PROBLEM], deps);

    expect(code).toBe(0);
    const stdout = out.join("\n");
    expect(stdout).toContain("use_existing");
    expect(stdout).toContain("dmaic covers >=80% of the need");
    expect(stdout).toContain("Build nothing");
    expect(fake.files.size).toBe(0); // nothing written on this path
    expect(countBySchema("typed_truths")).toBe(0); // short-circuited after triage
  });

  it("validation_failed: exit 1, failing criteria printed, no spec written", async () => {
    const { llm } = compilePipelineLlm({
      artifact_plan: () => ({
        artifacts: [{ ...GATE_ARTIFACT, traceability: { truthIds: ["t9"], constraintIds: [] } }],
      }),
    });
    const { deps, err, fake } = makeDeps({}, { llm });

    const code = await run(["compile", PROBLEM], deps);

    expect(code).toBe(1);
    const stderr = err.join("\n");
    expect(stderr).toContain("pv-traceability");
    expect(stderr).toContain("NOT written");
    expect(fake.files.size).toBe(0);
  });

  it("prints escalations prominently on stderr even when the spec is mechanically ready (invariant 5)", async () => {
    // ap-lazy fails on every judging round → artifact planning escalates.
    const { llm } = compilePipelineLlm({
      rubric_verdicts: (req) => ({
        verdicts: rubricIds(req.prompt).map((id) => ({
          criterionId: id,
          pass: id !== "ap-lazy",
          evidence:
            id === "ap-lazy"
              ? "cheapest path past the gate is pasting a placeholder trigger — cosmetic compliance"
              : `criterion ${id} satisfied by cited candidate content`,
        })),
      }),
    });
    const { deps, err, fake } = makeDeps({}, { llm });

    const code = await run(["compile", PROBLEM], deps);

    expect(code).toBe(0); // spec_ready — but the escalation is surfaced, never blessed
    expect(fake.files.has("process-spec.json")).toBe(true);
    const stderr = err.join("\n");
    expect(stderr).toContain("ESCALATION");
    expect(stderr).toContain("artifact planning");
    expect(stderr).toContain("ap-lazy");
  });

  it("--engram without a wired client warns and degrades gracefully to filesystem inventory", async () => {
    const { llm } = compilePipelineLlm();
    const { deps, err, fake } = makeDeps({}, { llm });

    const code = await run(["compile", PROBLEM, "--engram"], deps);

    expect(code).toBe(0); // run still completes
    expect(err.join("\n")).toContain("no Engram client");
    expect(fake.files.has("process-spec.json")).toBe(true);
  });

  it("--baseline: loads the operator baseline, feeds it to assess, and the deterministic row lands in the spec inventory", async () => {
    const baselineJson = JSON.stringify([
      {
        name: "engram-memory-api",
        kind: "service",
        location: "engram/api/memory",
        status: "built",
        receipt: "engram/api/memory/routes.py:42",
      },
    ]);
    const { llm, calls } = compilePipelineLlm();
    const { deps, out, fake } = makeDeps({ "baseline.json": baselineJson }, { llm });

    const code = await run(["compile", PROBLEM, "--baseline", "baseline.json"], deps);

    expect(code).toBe(0);
    // The baseline entered classification as an operator-baseline candidate
    // carrying its receipt as the hint.
    const classify = calls.find((c) => c.schemaName === "capability_inventory")!;
    expect(classify.prompt).toContain("source: operator-baseline");
    expect(classify.prompt).toContain("engram/api/memory/routes.py:42");
    // The operator-verified row survived to the written spec with its status
    // intact (constructed in code, not by the model).
    const spec = loadProcessSpec(fake.files.get("process-spec.json")!);
    expect(spec.assessment.inventory).toContainEqual({
      name: "engram-memory-api",
      kind: "service",
      location: "engram/api/memory",
      status: "built",
    });
    // The supplied-count note is surfaced in the compile report.
    expect(out.join("\n")).toContain("operator baseline supplied: 1 entry");
  });

  it("--baseline with a missing file is an operational error (exit 1) before any model call", async () => {
    const { llm, calls } = compilePipelineLlm();
    const { deps, err } = makeDeps({}, { llm });

    expect(await run(["compile", PROBLEM, "--baseline", "nope.json"], deps)).toBe(1);
    expect(err.join("\n")).toContain("No baseline inventory found at nope.json");
    expect(calls).toEqual([]); // rejected before the pipeline spent a single model call
  });

  it("--baseline with an invalid file (built entry lacking a receipt) is an operational error (exit 1) naming the offending path", async () => {
    const bad = JSON.stringify([{ name: "a", kind: "service", location: "x", status: "built" }]);
    const { llm, calls } = compilePipelineLlm();
    const { deps, err } = makeDeps({ "baseline.json": bad }, { llm });

    expect(await run(["compile", PROBLEM, "--baseline", "baseline.json"], deps)).toBe(1);
    const stderr = err.join("\n");
    expect(stderr).toContain("Failed to load baseline inventory baseline.json");
    expect(stderr).toContain("0.receipt");
    expect(stderr).toContain("unverified reuse claim");
    expect(calls).toEqual([]);
  });

  it("--baseline without a file argument is a usage error (exit 2)", async () => {
    const { llm, calls } = compilePipelineLlm();
    const { deps, err } = makeDeps({}, { llm });

    expect(await run(["compile", PROBLEM, "--baseline"], deps)).toBe(2);
    expect(err.join("\n")).toContain("--baseline requires a file argument");
    expect(calls).toEqual([]);
  });

  it("compile without a problem argument is a usage error (exit 2)", async () => {
    const { llm, calls } = compilePipelineLlm();
    const { deps, err } = makeDeps({}, { llm });

    expect(await run(["compile"], deps)).toBe(2);
    expect(err.join("\n")).toContain("Usage:");
    expect(calls).toEqual([]); // no model call on a usage error
  });

  it("compile without an LLM configured is an operational error (exit 1)", async () => {
    const { deps, err } = makeDeps();
    expect(await run(["compile", PROBLEM], deps)).toBe(1);
    expect(err.join("\n")).toContain("requires an LLM");
  });
});

describe("factory scan", () => {
  const dumpOf = (recs: OutcomeRecord[]) => JSON.stringify(recs);

  it("insufficient_data: below the sample floor exits 0 with the reason and ZERO llm calls", async () => {
    const { llm, callCount } = forbiddenLlm();
    const { deps, out } = makeDeps(
      { "seed.json": seedJson, "outcomes.json": dumpOf(records(3)) },
      { llm }
    );

    const code = await run(["scan", "--spec", "seed.json", "--outcomes", "outcomes.json"], deps);

    expect(code).toBe(0);
    expect(callCount()).toBe(0); // minimum-sample rule short-circuits before any model
    const stdout = out.join("\n");
    expect(stdout).toContain("insufficient_data");
    expect(stdout).toContain("minimum-sample rule");
    expect(stdout).not.toContain("NEVER auto-applied"); // no proposal on this path
  });

  it("honors --min-sample as the floor override", async () => {
    const { llm, callCount } = forbiddenLlm();
    // 20 clean records clear the seed's default floor of 20 — but not --min-sample 30.
    const { deps, out } = makeDeps(
      { "seed.json": seedJson, "outcomes.json": dumpOf(records(20)) },
      { llm }
    );

    const code = await run(
      ["scan", "--spec", "seed.json", "--outcomes", "outcomes.json", "--min-sample", "30"],
      deps
    );

    expect(code).toBe(0);
    expect(callCount()).toBe(0);
    expect(out.join("\n")).toContain("insufficient_data");
  });

  it("healthy: sufficient sample with zero defects exits 0 with the reason and ZERO llm calls", async () => {
    const { llm, callCount } = forbiddenLlm();
    const { deps, out } = makeDeps(
      { "seed.json": seedJson, "outcomes.json": dumpOf(records(20)) },
      { llm }
    );

    const code = await run(["scan", "--spec", "seed.json", "--outcomes", "outcomes.json"], deps);

    expect(code).toBe(0);
    expect(callCount()).toBe(0);
    expect(out.join("\n")).toContain("healthy");
  });

  it("propose: exit 0, prints verdict + diff + evidence and the never-auto-applied note; no file without --out", async () => {
    const recs = records(20);
    recs[0] = { ...recs[0], defect: true, evidence: "pack emitted without approval" };
    recs[1] = { ...recs[1], defect: true, evidence: "pack emitted without approval" };
    const { llm, countBySchema } = scanScriptedLlm();
    const { deps, out, fake } = makeDeps(
      { "seed.json": seedJson, "outcomes.json": dumpOf(recs) },
      { llm }
    );

    const code = await run(["scan", "--spec", "seed.json", "--outcomes", "outcomes.json"], deps);

    expect(code).toBe(0);
    expect(countBySchema("improvement_proposal")).toBe(1);
    const stdout = out.join("\n");
    expect(stdout).toContain("Verdict: propose");
    expect(stdout).toContain("knobs.0.default: 20 -> 10"); // the diff entry
    expect(stdout).toContain("r1: ctq1 defect in window 2026-W1"); // the evidence
    expect(stdout).toContain("NEVER auto-applied");
    expect(fake.files.size).toBe(0); // no --out → no write
  });

  it("propose with --out writes the proposal JSON via the injected fs", async () => {
    const recs = records(20);
    recs[0] = { ...recs[0], defect: true, evidence: "pack emitted without approval" };
    const { llm } = scanScriptedLlm();
    const outPath = path.join("proposals", "p1.json");
    const { deps, out, fake } = makeDeps(
      { "seed.json": seedJson, "outcomes.json": dumpOf(recs) },
      { llm }
    );

    const code = await run(
      ["scan", "--spec", "seed.json", "--outcomes", "outcomes.json", "--out", outPath],
      deps
    );

    expect(code).toBe(0);
    const proposal = JSON.parse(fake.files.get(outPath)!);
    expect(proposal.verdict).toBe("propose");
    expect(proposal.packName).toBe("process-factory-meta");
    expect(proposal.specDiff).toHaveLength(1);
    expect(out.join("\n")).toContain(outPath);
  });

  it("missing required args are usage errors (exit 2), zero llm calls", async () => {
    const { llm, callCount } = forbiddenLlm();
    const { deps, err } = makeDeps({ "seed.json": seedJson }, { llm });

    expect(await run(["scan", "--outcomes", "outcomes.json"], deps)).toBe(2);
    expect(err.join("\n")).toContain("--spec");
    expect(await run(["scan", "--spec", "seed.json"], deps)).toBe(2);
    expect(err.join("\n")).toContain("--outcomes");
    expect(await run(["scan"], deps)).toBe(2);
    expect(err.join("\n")).toContain("Usage:");
    expect(callCount()).toBe(0);
  });

  it("a non-integer --min-sample is a usage error (exit 2)", async () => {
    const { llm } = forbiddenLlm();
    const { deps, err } = makeDeps(
      { "seed.json": seedJson, "outcomes.json": dumpOf(records(3)) },
      { llm }
    );
    expect(
      await run(["scan", "--spec", "seed.json", "--outcomes", "outcomes.json", "--min-sample", "lots"], deps)
    ).toBe(2);
    expect(err.join("\n")).toContain("--min-sample");
  });

  it("a spec failing a mechanical validator exits 1, prints the failing criterion, and never scans (zero llm calls)", async () => {
    const spec = JSON.parse(seedJson) as ProcessSpec;
    spec.artifacts[0].traceability = { truthIds: [], constraintIds: [] }; // orphan → pv-traceability
    const { llm, callCount } = forbiddenLlm();
    const { deps, err } = makeDeps(
      { "bad.json": JSON.stringify(spec), "outcomes.json": dumpOf(records(20)) },
      { llm }
    );

    const code = await run(["scan", "--spec", "bad.json", "--outcomes", "outcomes.json"], deps);

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("refusing to scan");
    expect(err.join("\n")).toContain("pv-traceability");
    expect(err.join("\n")).toContain(spec.artifacts[0].name); // offender evidence surfaced
    expect(callCount()).toBe(0); // validation gate fires before any model call
  });

  it("a missing spec or dump file exits 1 with a readable error naming the path", async () => {
    const { llm } = forbiddenLlm();
    const { deps, err } = makeDeps({ "seed.json": seedJson }, { llm });

    expect(await run(["scan", "--spec", "nope.json", "--outcomes", "outcomes.json"], deps)).toBe(1);
    expect(err.join("\n")).toContain("nope.json");
    expect(await run(["scan", "--spec", "seed.json", "--outcomes", "missing.json"], deps)).toBe(1);
    expect(err.join("\n")).toContain("missing.json");
  });

  it("an invalid outcome dump exits 1 with the shape error, zero llm calls", async () => {
    const { llm, callCount } = forbiddenLlm();
    const { deps, err } = makeDeps(
      { "seed.json": seedJson, "outcomes.json": JSON.stringify({ records: [] }) },
      { llm }
    );

    expect(await run(["scan", "--spec", "seed.json", "--outcomes", "outcomes.json"], deps)).toBe(1);
    expect(err.join("\n")).toContain("outcomes.json");
    expect(callCount()).toBe(0);
  });

  it("scan without an LLM configured is an operational error (exit 1)", async () => {
    const { deps, err } = makeDeps({ "seed.json": seedJson, "outcomes.json": "[]" });
    expect(await run(["scan", "--spec", "seed.json", "--outcomes", "outcomes.json"], deps)).toBe(1);
    expect(err.join("\n")).toContain("requires an LLM");
  });
});

describe("factory models", () => {
  // The models verb resolves its config from process.env (resolveProviderConfig
  // + the PRINCIPLES_MODEL selection marker) — clear every provider variable
  // before each test and restore the developer's real values afterwards.
  const ENV_KEYS = [
    "PRINCIPLES_PROVIDER",
    "PRINCIPLES_MODEL",
    "PRINCIPLES_BASE_URL",
    "PRINCIPLES_API_KEY",
    "XAI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  /** Injected fetchJson recording every call; resolves with the given body. */
  function recordingFetch(body: unknown) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchJson = async (url: string, headers: Record<string, string>) => {
      calls.push({ url, headers });
      return body;
    };
    return { fetchJson, calls };
  }

  const LISTING = {
    data: [
      { id: "openai/gpt-4.1", owned_by: "openai" },
      { id: "grok-4.5" },
      { id: "grok-3" },
      { id: "claude-sonnet-5", owned_by: "anthropic" },
    ],
  };

  it("happy path: groups ids by family, marks the selected PRINCIPLES_MODEL, sends the bearer key", async () => {
    process.env.XAI_API_KEY = "xai-test-key";
    process.env.PRINCIPLES_MODEL = "grok-4.5";
    const { fetchJson, calls } = recordingFetch(LISTING);
    const { deps, out, err } = makeDeps({}, { fetchJson });

    const code = await run(["models"], deps);

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(calls).toEqual([
      { url: "https://api.x.ai/v1/models", headers: { Authorization: "Bearer xai-test-key" } },
    ]);
    const stdout = out.join("\n");
    // Provider + base URL header line, then families sorted with their ids.
    expect(stdout).toContain("Provider: xai");
    expect(stdout).toContain("https://api.x.ai/v1");
    expect(out).toContain("claude:");
    expect(out).toContain("  claude-sonnet-5");
    expect(out).toContain("grok:");
    expect(out).toContain("  grok-3");
    expect(out).toContain("  grok-4.5 * (selected)");
    expect(out).toContain("openai:");
    expect(out).toContain("  openai/gpt-4.1"); // "/" namespace beats "-" splitting
    expect(out.indexOf("claude:")).toBeLessThan(out.indexOf("grok:")); // sorted families
    expect(out.indexOf("grok:")).toBeLessThan(out.indexOf("openai:"));
    expect(stdout).not.toContain("not visible to this key"); // selected IS listed
  });

  it("honors PRINCIPLES_BASE_URL for the listing endpoint (LiteLLM proxy case)", async () => {
    process.env.XAI_API_KEY = "k";
    process.env.PRINCIPLES_BASE_URL = "http://localhost:4000/v1";
    const { fetchJson, calls } = recordingFetch({ data: [] });
    const { deps } = makeDeps({}, { fetchJson });

    expect(await run(["models"], deps)).toBe(0);
    expect(calls[0].url).toBe("http://localhost:4000/v1/models");
  });

  it("a selected model absent from the listing gets the not-visible trailing note", async () => {
    process.env.XAI_API_KEY = "k";
    process.env.PRINCIPLES_MODEL = "grok-99-imaginary";
    const { fetchJson } = recordingFetch(LISTING);
    const { deps, out } = makeDeps({}, { fetchJson });

    const code = await run(["models"], deps);

    expect(code).toBe(0);
    const stdout = out.join("\n");
    expect(stdout).toContain("grok-99-imaginary");
    expect(stdout).toContain("selected model not visible to this key");
    expect(stdout).not.toContain("* (selected)"); // nothing in the list to mark
  });

  it("no PRINCIPLES_MODEL set: nothing is marked selected and no note is printed", async () => {
    process.env.XAI_API_KEY = "k";
    const { fetchJson } = recordingFetch(LISTING);
    const { deps, out } = makeDeps({}, { fetchJson });

    expect(await run(["models"], deps)).toBe(0);
    const stdout = out.join("\n");
    expect(stdout).not.toContain("* (selected)");
    expect(stdout).not.toContain("not visible to this key");
  });

  it("missing API key exits 1 with a readable error and never fetches", async () => {
    const { fetchJson, calls } = recordingFetch(LISTING);
    const { deps, err } = makeDeps({}, { fetchJson });

    const code = await run(["models"], deps);

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    const stderr = err.join("\n");
    expect(stderr).toContain("No API key configured");
    expect(stderr).toContain("XAI_API_KEY");
  });

  it("a failing fetch exits 1 surfacing the error (status) plus the LiteLLM hint", async () => {
    process.env.XAI_API_KEY = "k";
    const fetchJson = async () => {
      throw new Error("HTTP 502 Bad Gateway");
    };
    const { deps, err } = makeDeps({}, { fetchJson });

    const code = await run(["models"], deps);

    expect(code).toBe(1);
    const stderr = err.join("\n");
    expect(stderr).toContain("HTTP 502 Bad Gateway");
    expect(stderr).toContain("https://api.x.ai/v1/models");
    expect(stderr).toContain("LiteLLM");
  });

  it("a non-OpenAI response shape exits 1 naming the expected shape", async () => {
    process.env.XAI_API_KEY = "k";
    const { fetchJson } = recordingFetch({ models: ["grok-4.5"] }); // wrong key
    const { deps, err } = makeDeps({}, { fetchJson });

    expect(await run(["models"], deps)).toBe(1);
    expect(err.join("\n")).toContain("{ data: [{ id }] }");
  });

  it("claude provider is informational: exit 0, Agent SDK note, ZERO fetches", async () => {
    process.env.PRINCIPLES_PROVIDER = "claude";
    const { fetchJson, calls } = recordingFetch(LISTING);
    const { deps, out } = makeDeps({}, { fetchJson });

    const code = await run(["models"], deps);

    expect(code).toBe(0);
    expect(calls).toEqual([]); // no listing endpoint to hit
    const stdout = out.join("\n");
    expect(stdout).toContain("Provider: claude");
    expect(stdout).toContain("Agent SDK resolves models internally");
  });

  it("models with an unexpected argument is a usage error (exit 2), no fetch", async () => {
    process.env.XAI_API_KEY = "k";
    const { fetchJson, calls } = recordingFetch(LISTING);
    const { deps, err } = makeDeps({}, { fetchJson });

    expect(await run(["models", "--verbose"], deps)).toBe(2);
    expect(err.join("\n")).toContain("Usage:");
    expect(calls).toEqual([]);
  });
});

describe("factory verbs", () => {
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
