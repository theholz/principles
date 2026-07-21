import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "path";
import os from "os";
import { emitProcessPack, EmitFs } from "../../src/factory/emitters/processPack";
import { loadProcessSpec } from "../../src/factory/loadSpec";
import { ProcessSpec } from "../../src/factory/types";

const seedPath = path.join(__dirname, "..", "..", "seeds", "factory-meta", "process-spec.json");
const seedJson = fs.readFileSync(seedPath, "utf8");

/** Fresh, fully-validated copy of the real seed spec per test. */
const seed = (): ProcessSpec => loadProcessSpec(seedJson);

/** Sorted relative paths of every file under dir. */
const walk = (dir: string, base = dir): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const abs = path.join(dir, e.name);
      return e.isDirectory() ? walk(abs, base) : [path.relative(base, abs)];
    })
    .sort();

describe("emitProcessPack", () => {
  let tmp: string;
  let outDir: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "process-pack-test-"));
    outDir = path.join(tmp, "pack");
  });
  afterEach(() => {
    fs.removeSync(tmp);
  });

  it("emits exactly the expected file tree from the seed", () => {
    const returned = emitProcessPack(seed(), outDir);
    expect(returned).toBe(outDir);
    expect(walk(outDir)).toEqual(
      [
        path.join(".claude-plugin", "plugin.json"),
        path.join("gates", "spec-approval-gate.md"),
        path.join("hooks", "deploy-discipline-hook.md"),
        path.join("manifest", "forge-handoff.json"),
        path.join("manifest", "metrics.json"),
        "process-spec.json",
        path.join("skills", "factory-intake", "SKILL.md"),
      ].sort()
    );
  });

  it("writes a plugin manifest in the real installed-plugin format", () => {
    emitProcessPack(seed(), outDir);
    const manifest = fs.readJsonSync(path.join(outDir, ".claude-plugin", "plugin.json"));
    expect(manifest.name).toBe("process-factory-meta");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toContain("Operate the process factory");
    expect(manifest.domain).toBe("process-factory-operations");
    expect(manifest.keywords).toEqual([
      "process-factory-operations",
      "first-principles",
      "theory-of-constraints",
      "dmaic",
    ]);
  });

  it("metrics.json carries the pack contract and knobs verbatim", () => {
    const spec = seed();
    emitProcessPack(spec, outDir);
    const metrics = fs.readJsonSync(path.join(outDir, "manifest", "metrics.json"));
    expect(metrics.ctqs).toEqual(spec.contract.ctqs);
    expect(metrics.baseline).toBe("unmeasured");
    expect(metrics.decisionRule).toBe(spec.contract.decisionRule);
    expect(metrics.controlPlan).toEqual(spec.contract.controlPlan);
    expect(metrics.governancePhase).toBe("shadow");
    expect(metrics.knobs).toEqual(spec.knobs);
  });

  it("forge-handoff.json is an empty array when nothing is forge_new (the seed)", () => {
    emitProcessPack(seed(), outDir);
    expect(fs.readJsonSync(path.join(outDir, "manifest", "forge-handoff.json"))).toEqual([]);
  });

  it("forge-handoff.json carries forge_new artifacts in skill-forge handoff shape", () => {
    const spec = seed();
    spec.artifacts.push({
      name: "retro-recorder",
      kind: "skill",
      disposition: "forge_new",
      traceability: { truthIds: ["t2"], constraintIds: [] },
      l2Rationale: "Retrospectives need forge-quality trigger optimization.",
      relationships: {
        dependsOn: [],
        complements: ["factory-intake"],
        composesWith: [],
        supersedes: [],
        bindsTools: [],
      },
    });
    emitProcessPack(spec, outDir);
    const handoff = fs.readJsonSync(path.join(outDir, "manifest", "forge-handoff.json"));
    expect(handoff).toEqual([
      {
        name: "retro-recorder",
        kind: "skill",
        traceability: { truthIds: ["t2"], constraintIds: [] },
        l2Rationale: "Retrospectives need forge-quality trigger optimization.",
        relationships: {
          dependsOn: [],
          complements: ["factory-intake"],
          composesWith: [],
          supersedes: [],
          bindsTools: [],
        },
      },
    ]);
    // forge_new skills get NO SKILL.md — skill-forge is their sole producer.
    expect(fs.existsSync(path.join(outDir, "skills", "retro-recorder"))).toBe(false);
  });

  it("embeds the input spec verbatim and it round-trips through loadProcessSpec", () => {
    const spec = seed();
    emitProcessPack(spec, outDir);
    const embedded = fs.readFileSync(path.join(outDir, "process-spec.json"), "utf8");
    expect(loadProcessSpec(embedded)).toEqual(spec);
  });

  it("SKILL.md frontmatter parses and carries the metrics block", () => {
    emitProcessPack(seed(), outDir);
    const skill = fs.readFileSync(path.join(outDir, "skills", "factory-intake", "SKILL.md"), "utf8");
    // Frontmatter delimiters + fields (string checks; strings are YAML double-quoted).
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill.split("---\n").length).toBeGreaterThanOrEqual(3);
    expect(skill).toContain('name: "factory-intake"');
    expect(skill).toContain('version: "0.1.0"');
    expect(skill).toContain('complements: ["spec-approval-gate"]');
    expect(skill).toContain("metadata:");
    expect(skill).toContain("  metrics:");
    expect(skill).toContain('    prometheus_prefix: "skill_factory_intake_"');
    expect(skill).toContain('    langfuse_tag: "skill.factory-intake.v0.1.0"');
    expect(skill).toContain('    governance_phase: "shadow"');
    expect(skill).toContain('    baseline: "unmeasured"');
    expect(skill).toContain('      - id: "ctq1"');
    // Description derived from l2Rationale + traced truths.
    expect(skill).toContain("cheapest intervention");
    expect(skill).toContain('Serves truths: t1');
  });

  it("SKILL.md body carries provenance, role instructions, related skills, and When You're Done", () => {
    emitProcessPack(seed(), outDir);
    const skill = fs.readFileSync(path.join(outDir, "skills", "factory-intake", "SKILL.md"), "utf8");
    // Traced truth quoted verbatim.
    expect(skill).toContain('"A process spec must be operator-approved before emission."');
    // Role serving the same truth, with its instructions.
    expect(skill).toContain("### intake-operator (`agent-s1`)");
    expect(skill).toContain("confirm the restatement with the operator");
    expect(skill).toContain("Accountable CTQs: ctq1");
    // Methodology deps as related skills.
    expect(skill).toContain("## Related skills");
    expect(skill).toContain("`theory-of-constraints`");
    // Outcome-recording block.
    expect(skill).toContain("## When You're Done");
    expect(skill).toContain("Outcome: success | partial | failed");
    expect(skill).toContain("What you'd do differently");
  });

  it("hook stubs document event, matcher intent, enforcement — and say they are not live code", () => {
    emitProcessPack(seed(), outDir);
    const hook = fs.readFileSync(path.join(outDir, "hooks", "deploy-discipline-hook.md"), "utf8");
    expect(hook).toContain("**Not live hook code.**");
    expect(hook).toContain("later");
    expect(hook).toContain("## Event");
    expect(hook).toContain("## Matcher intent");
    expect(hook).toContain("## Enforcement");
    expect(hook).toContain('Phase "shadow": observe and record violations; never block.');
    // Provenance quoted verbatim.
    expect(hook).toContain('"Deploys land only as draft PRs into engram-plugins, never as direct pushes."');
  });

  it("gate stubs get the same treatment plus the lazy-agent test note", () => {
    emitProcessPack(seed(), outDir);
    const gate = fs.readFileSync(path.join(outDir, "gates", "spec-approval-gate.md"), "utf8");
    expect(gate).toContain("**Not live gate code.**");
    expect(gate).toContain("## Matcher intent");
    expect(gate).toContain("## Enforcement");
    expect(gate).toContain("cheapest path past this gate");
    // The gate cites the TOC constraint as well as its truth.
    expect(gate).toContain('"Nothing enforces spec-approval-before-emit today');
  });

  it("every emitted text file matches its snapshot", () => {
    emitProcessPack(seed(), outDir);
    for (const rel of walk(outDir)) {
      expect(fs.readFileSync(path.join(outDir, rel), "utf8")).toMatchSnapshot(rel);
    }
  });

  it("refuses to emit when outDir already exists", () => {
    fs.ensureDirSync(outDir);
    expect(() => emitProcessPack(seed(), outDir)).toThrow(/already exists/);
    expect(fs.readdirSync(outDir)).toEqual([]); // untouched
  });

  it("a templating failure (unsupported generate kind) writes nothing at all", () => {
    const spec = seed();
    spec.artifacts.push({
      name: "mystery-agent",
      kind: "agent",
      disposition: "generate",
      traceability: { truthIds: ["t1"], constraintIds: [] },
      l2Rationale: "r",
      relationships: { dependsOn: [], complements: [], composesWith: [], supersedes: [], bindsTools: [] },
    });
    expect(() => emitProcessPack(spec, outDir)).toThrow(/not yet supported/);
    expect(fs.existsSync(outDir)).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]); // no temp litter either
  });

  it("refuses to emit provenance it cannot verify (unknown truth id)", () => {
    const spec = seed();
    spec.artifacts[0].traceability.truthIds = ["t99"];
    expect(() => emitProcessPack(spec, outDir)).toThrow(/unknown truth id "t99"/);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("refuses an unknown constraint id", () => {
    const spec = seed();
    spec.artifacts[1].traceability.constraintIds = ["c9"];
    expect(() => emitProcessPack(spec, outDir)).toThrow(/unknown constraint id "c9"/);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("refuses duplicate emitted paths (two hooks with the same name)", () => {
    const spec = seed();
    const hook = spec.artifacts.find((a) => a.kind === "hook")!;
    spec.artifacts.push({ ...hook });
    expect(() => emitProcessPack(spec, outDir)).toThrow(/duplicate emitted path/);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("refuses artifact names that are not filesystem-safe", () => {
    const spec = seed();
    spec.artifacts[0].name = "../escape";
    expect(() => emitProcessPack(spec, outDir)).toThrow(/not filesystem-safe/);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("an fs failure mid-write removes the temp dir and leaves outDir absent", () => {
    const failing: EmitFs = {
      existsSync: (p) => fs.existsSync(p),
      ensureDirSync: (p) => {
        fs.ensureDirSync(p);
      },
      writeFileSync: (p, data) => {
        if (p.endsWith("metrics.json")) throw new Error("disk full (injected)");
        fs.writeFileSync(p, data);
      },
      renameSync: (from, to) => fs.renameSync(from, to),
      removeSync: (p) => fs.removeSync(p),
    };
    expect(() => emitProcessPack(seed(), outDir, { fs: failing })).toThrow(/disk full/);
    expect(fs.existsSync(outDir)).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]); // temp dir cleaned up
  });

  it("a cleanup failure during error recovery never masks the original error", () => {
    const failing: EmitFs = {
      existsSync: (p) => fs.existsSync(p),
      ensureDirSync: (p) => {
        fs.ensureDirSync(p);
      },
      writeFileSync: (p, data) => {
        if (p.endsWith("metrics.json")) throw new Error("disk full (injected)");
        fs.writeFileSync(p, data);
      },
      renameSync: (from, to) => fs.renameSync(from, to),
      removeSync: () => {
        throw new Error("cleanup also failed (injected)");
      },
    };
    // The ORIGINAL write error surfaces — the removeSync failure is swallowed.
    expect(() => emitProcessPack(seed(), outDir, { fs: failing })).toThrow(/disk full/);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it("hostile strings (quotes, colons, newlines, ${}) in a truth and l2Rationale emit parseable, safely-quoted frontmatter", () => {
    const HOSTILE = 'gotcha: "quoted"\n---\ninjected: yes ${process.env.SECRET}';
    const spec = seed();
    spec.foundations.truths[0].statement = HOSTILE; // t1 — cited by the factory-intake skill
    const intake = spec.artifacts.find((a) => a.name === "factory-intake")!;
    intake.l2Rationale = HOSTILE;

    emitProcessPack(spec, outDir);
    const skill = fs.readFileSync(path.join(outDir, "skills", "factory-intake", "SKILL.md"), "utf8");

    // Frontmatter still parses: delimited, and every line stays key/list
    // structured — an unescaped newline or a bare --- smuggled out of the
    // hostile strings would break this loop.
    expect(skill.startsWith("---\n")).toBe(true);
    const frontmatter = skill.split("---\n")[1];
    expect(frontmatter.length).toBeGreaterThan(0);
    for (const line of frontmatter.trimEnd().split("\n")) {
      expect(line).toMatch(/^ *([A-Za-z_]+:|- )/);
    }

    // The hostile strings appear only as escaped double-quoted scalars: the
    // exact yq/JSON form — newlines escaped to \n, quotes to \" — verbatim.
    const expectedDescription = `${HOSTILE} Serves truths: t1 ("${HOSTILE}").`;
    expect(skill).toContain(`description: ${JSON.stringify(expectedDescription)}`);

    // The markdown body (no parse contract) still carries the provenance.
    expect(skill).toContain("## Purpose");
    expect(skill).toContain("**t1**");
  });
});
