import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "path";
import os from "os";
import { loadProcessSpec } from "../../src/factory/loadSpec";
import {
  renderGrokPack,
  emitGrokPack,
  subtaskLevels,
  roleCapabilityMode,
} from "../../src/factory/emitters/grokPack";
import { ProcessSpec } from "../../src/factory/types";

const seedPath = path.join(__dirname, "..", "..", "seeds", "factory-meta", "process-spec.json");
const seedJson = fs.readFileSync(seedPath, "utf8");
const bizPath = path.join(__dirname, "..", "..", "seeds", "business-process", "process-spec.json");
const bizJson = fs.readFileSync(bizPath, "utf8");

/** Fresh, fully-validated copy of the real seed spec per test. */
const seed = (): ProcessSpec => loadProcessSpec(seedJson);
const biz = (): ProcessSpec => loadProcessSpec(bizJson);

describe("subtaskLevels", () => {
  it("levelizes a diamond DAG: s1[]; s2[s1]; s3[s1] → [[s1],[s2,s3]]", () => {
    const levels = subtaskLevels([
      { id: "s1", dependsOn: [] },
      { id: "s2", dependsOn: ["s1"] },
      { id: "s3", dependsOn: ["s1"] },
    ]);
    expect(levels).toEqual([["s1"], ["s2", "s3"]]);
  });

  it("levelizes a chain s1→s2→s3 as three sequential levels", () => {
    const levels = subtaskLevels([
      { id: "s1", dependsOn: [] },
      { id: "s2", dependsOn: ["s1"] },
      { id: "s3", dependsOn: ["s2"] },
    ]);
    expect(levels).toEqual([["s1"], ["s2"], ["s3"]]);
  });

  it("preserves input order within a level", () => {
    const levels = subtaskLevels([
      { id: "s3", dependsOn: [] },
      { id: "s1", dependsOn: [] },
      { id: "s2", dependsOn: [] },
    ]);
    expect(levels).toEqual([["s3", "s1", "s2"]]);
  });

  it("throws on a cycle", () => {
    expect(() =>
      subtaskLevels([
        { id: "s1", dependsOn: ["s2"] },
        { id: "s2", dependsOn: ["s1"] },
      ])
    ).toThrow(/cyclic|unsatisfiable/i);
  });
});

describe("renderGrokPack", () => {
  it("emits an agent md per role with name and truth/instructions content", () => {
    const files = Object.fromEntries(renderGrokPack(seed()));
    const agent = files["agents/intake-operator.md"];
    expect(agent).toBeDefined();
    expect(agent).toMatch(/name:\s*intake-operator/);
    expect(agent).toMatch(/Serves truths|servesTruths/i);
    expect(agent).toContain("Receive the operator's problem statement");
  });

  it("emits a persona toml per role with instructions and [[outputs]]", () => {
    const files = Object.fromEntries(renderGrokPack(seed()));
    const persona = files["personas/intake-operator.toml"];
    expect(persona).toBeDefined();
    expect(persona).toMatch(/instructions\s*=/);
    expect(persona).toMatch(/\[\[outputs\]\]/);
  });

  it("embeds process-spec.json with meta.name process-factory-meta", () => {
    const files = Object.fromEntries(renderGrokPack(seed()));
    const parsed = JSON.parse(files["process-spec.json"]);
    expect(parsed.meta.name).toBe("process-factory-meta");
  });

  it("embeds manifest/metrics.json", () => {
    const files = Object.fromEntries(renderGrokPack(seed()));
    expect(files["manifest/metrics.json"]).toBeTruthy();
    const metrics = JSON.parse(files["manifest/metrics.json"]);
    expect(metrics.governancePhase).toBe("shadow");
    expect(metrics.ctqs).toEqual(seed().contract.ctqs);
  });

  it("emits generate skills when present", () => {
    const files = Object.fromEntries(renderGrokPack(seed()));
    expect(files["skills/factory-intake/SKILL.md"]).toBeDefined();
    expect(files["skills/factory-intake/SKILL.md"]).toMatch(/factory-intake/);
  });

  it("emits workflows/process-factory-meta.rhai with meta literal and agent() for intake-operator", () => {
    const files = Object.fromEntries(renderGrokPack(seed()));
    const rhai = files["workflows/process-factory-meta.rhai"];
    expect(rhai).toBeDefined();
    // First statement pure-literal meta (create-workflow constraint).
    expect(rhai.trimStart().startsWith("let meta = #{")).toBe(true);
    expect(rhai).toContain('name: "process-factory-meta"');
    expect(rhai).toContain("agent(");
    // Role name appears as agent_type or label.
    expect(rhai).toMatch(/agent_type:\s*"intake-operator"|label:\s*"intake-operator"/);
    // No forbidden fork_context in authored project scripts.
    expect(rhai).not.toMatch(/fork_context/);
    // Guard pattern for agent results.
    expect(rhai).toMatch(/!=\s*\(\)/);
  });

  it("emits roles/<name>.toml with capability heuristic", () => {
    const files = Object.fromEntries(renderGrokPack(seed()));
    const roleToml = files["roles/intake-operator.toml"];
    expect(roleToml).toBeDefined();
    expect(roleToml).toMatch(/default_capability_mode\s*=\s*"all"/);
  });

  it("SC7: never emits hooks/hooks.json; ships hooks-policy instead", () => {
    const files = Object.fromEntries(renderGrokPack(seed()));
    expect(files["hooks/hooks.json"]).toBeUndefined();
    expect(Object.keys(files).some((k) => k.startsWith("hooks/"))).toBe(false);
    const policy = JSON.parse(files["manifest/hooks-policy.json"]);
    expect(policy.autoEmitLiveHooks).toBe(false);
    expect(policy.policy).toBe("opt-in-only");
  });
});

describe("roleCapabilityMode", () => {
  it("maps review/audit names to read-only", () => {
    expect(roleCapabilityMode("review-steward")).toBe("read-only");
    expect(roleCapabilityMode("audit-pack")).toBe("read-only");
    expect(roleCapabilityMode("accord-sweeper")).toBe("read-only");
  });

  it("maps implement/emit and defaults to all", () => {
    expect(roleCapabilityMode("implement-steward")).toBe("all");
    expect(roleCapabilityMode("intake-operator")).toBe("all");
  });
});

describe("business-process seed (Task 7)", () => {
  it("emits all six steward agents and review is read-only", () => {
    const files = Object.fromEntries(renderGrokPack(biz()));
    for (const name of [
      "intake-steward",
      "plan-steward",
      "implement-steward",
      "review-steward",
      "capture-steward",
      "accord-sweeper",
    ]) {
      expect(files[`agents/${name}.md`]).toBeDefined();
      expect(files[`roles/${name}.toml`]).toBeDefined();
    }
    expect(files["roles/review-steward.toml"]).toMatch(/default_capability_mode\s*=\s*"read-only"/);
    expect(files["roles/implement-steward.toml"]).toMatch(/default_capability_mode\s*=\s*"all"/);
    const rhai = files["workflows/engram-business-processes.rhai"];
    expect(rhai).toBeDefined();
    expect(rhai).toMatch(/agent_type:\s*"review-steward"/);
    expect(rhai).toMatch(/capability_mode:\s*"read-only"/);
  });
});

describe("emitGrokPack", () => {
  let tmp: string;
  let outDir: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-pack-test-"));
    outDir = path.join(tmp, "pack");
  });
  afterEach(() => {
    fs.removeSync(tmp);
  });

  it("refuses if outDir already exists", () => {
    fs.ensureDirSync(outDir);
    expect(() => emitGrokPack(seed(), outDir)).toThrow(/already exists/);
  });

  it("writes files then succeeds", () => {
    const returned = emitGrokPack(seed(), outDir);
    expect(returned).toBe(outDir);
    expect(fs.existsSync(path.join(outDir, "agents", "intake-operator.md"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "personas", "intake-operator.toml"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "process-spec.json"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "manifest", "metrics.json"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "skills", "factory-intake", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "workflows", "process-factory-meta.rhai"))).toBe(true);
    const written = loadProcessSpec(fs.readFileSync(path.join(outDir, "process-spec.json"), "utf8"));
    expect(written.meta.name).toBe("process-factory-meta");
  });
});
