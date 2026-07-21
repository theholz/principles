# Process Factory v1 — Design

**Date:** 2026-07-20
**Status:** Approved in brainstorm (operator sign-off per section); pre-implementation-plan
**Home:** principles repo (engine) + engram-plugins (deployment surface)

---

## 1. Problem & mission

Build a **process factory**: given any problem or operational domain, compile the right
process — the agents, skills, hooks, gates, and plugins it needs — and own that process
cradle-to-grave: measure it, maintain it, and propose improvements for as long as it is
deployed.

Mission statement: **cradle-to-grave process ownership.** The factory is not a vending
machine that emits artifacts; it is a factory with a service department. It achieves
lifecycle ownership by baking sensory machinery into every creation at birth and keeping
the improvement machinery centralized in itself.

## 2. Locked decisions

| Fork | Decision | Alternatives considered |
|---|---|---|
| V1 output artifact | **Hybrid: runtime-neutral process spec + per-target emitters** (process-pack emitter first, LangGraph emitter later per WL-DATA-15) | Claude Code packs only; principles packages only; Engram LangGraph only |
| Engine home | **Extend the principles repo** (TypeScript, deterministic, fake-LLM-testable, Grok-driven via the fork's `resolveLlm`/`openaiCompatibleGateway`) with a thin TUI plugin wrapper | New engram plugin only (prompt-driven); Engram brain Python service |
| Methodology integration | **Compile-time + runtime**: TOC and DMAIC become typed pipeline stages; emitted packs also `depends_on` the methodologies skills | Compile-time only; runtime deps only |
| Self-improvement | **Measure + propose; human applies** (D-044, D-065 respected) | Manual re-run only; auto-regen in shadow |
| First validation target | **The factory itself (meta)**, with a hand-authored seed spec as the anti-correlated-error mechanism; second target = a real WL-PROC-05 process (proposed: `intake`) | WL-PROC-05 process first; trading domain; synthetic problem |
| Improvement topology | **Sensing distributed, improving centralized** (see §5) | Fully centralized (dumb packs); fully distributed (self-modifying packs) |

## 3. Resources composed (orchestrate, never reimplement)

| Resource | Role in the factory |
|---|---|
| **feature-framework** (engram-plugins/dev-workflow) | Stage-1 method: inventory discipline ("confirm gaps, don't assume"), TOC constraint identification, the L2 intervention-routing table, the lazy-agent test, the reuse record |
| **skill-forge** (engram-plugins/skill-forge) | Sole producer of new skills (factory hands off, never generates skills blind); source of the triage-verdict pattern, traceability gate, conflict check (`scripts/portable/conflict_check.py`), eval infra, description/trigger optimization, Phase-6 metrics format, shadow→enforcement ladder, Neo4j relationship model |
| **principles repo** (this repo) | The decomposition core: typed truths → skeptic attack → truth-citing subtasks → agent specs → rubrics. Refine loops (`src/shared/refine.ts`), evidence-requiring judges (`src/shared/judge.ts`), structured-output-safe schema discipline, fake-LLM test style, bench-harness pattern |
| **methodologies plugin** | first-principles = decomposition spine (already embodied in the core); theory-of-constraints = stage-1 constraint analysis; DMAIC = stage-3 contract (Define/Measure) + control plans; all three become runtime `depends_on` of emitted packs |
| **Engram** | Runtime + measurement substrate: `skill_usage_events`, workflow records, process-improvement scan (WL-SKILL-2b), fidelity gates (WL-GOV-03), skill router/reindex (WL-39), marketplace + adversarial-review promote path (D-016/D-065), AGT governance (always-on, D-064) |

Note the shared DNA: skill-forge's refinement loop was itself borrowed from
miltonian/principles — the factory composes systems that already speak the same language.

## 4. Architecture — the 8-stage compilation pipeline

```
problem/goal
    │
[1] ASSESS ············ feature-framework mechanized: deterministic inventory scan
    │                   (marketplace checkout, plugin/skill dirs; optional --engram
    │                   live-router query, degrades offline) + LLM triage verdict with
    │                   forge thresholds (use_existing ≥80% / improve_existing 50–79% /
    │                   compose / create_new) + TOC constraint analysis. Constraint
    │                   claims are skeptic-attacked like truths. "Build nothing" is a
    │                   valid, cheap outcome.
    │
[2] DECOMPOSE ········· existing principles core, unchanged. One enrichment: the goal is
    │                   prefixed with the assessment summary so truths ground in the
    │                   actual environment. Existing schemaNames untouched.
    │
[3] CONTRACT ·········· DMAIC Define/Measure compiled in: CTQ metrics (persona → metric
    │                   → spec limit → defect definition), baseline (real value or honest
    │                   "unmeasured"; judges reject invented numbers), decision rule,
    │                   control plan, governance_phase: shadow at birth.
    │
[4] PROCESS SPEC ······ deterministic assembly + mechanical validators + LLM artifact
    │                   plan (L2-routed, rationale judged). See §6.
    │
[5] EMIT ·············· per-target emitters. V1: process-pack emitter → Claude Code
    │                   plugin dir. forge_new skills → skill-forge handoff manifest.
    │                   Later: LangGraph emitter (WL-DATA-15 slot).
    │
[6] DEPLOY ············ branch + draft PR into engram-plugins (D-016/D-065), conflict
    │                   check, registry update in the same PR, reindex_skills (WL-39).
    │
[7] MEASURE ··········· pack-side instrumentation → existing Engram stores. The factory's
    │                   job here was compiling the manifest correctly.
    │
[8] IMPROVE ··········· scan mode: outcomes vs decision rules → improvement_proposal
                        (spec diff + evidence) → regenerated pack as draft → needs-review
                        queue. Per-pack AND portfolio-wide (cross-pack Pareto; those
                        proposals target the factory's own stages/templates). Applies
                        nothing (D-044).
```

**HITL stop-gates:** operator approves the process spec before emit (end of stage 4);
deploy always lands as a draft PR; every improvement proposal is human-applied.

**Scaling table:** stage depth scales with problem complexity (trivial → complex), forge
style — every stage is touched, but a trivial domain gets bullets where a complex one
gets the full treatment. The tier is recorded in `meta.scaling_tier`.

## 5. Improvement topology — sensing distributed, improving centralized

Single-loop vs double-loop learning:

**Baked into every creation (sensory half):**
- Metrics manifest: CTQs, baseline, decision rule, `governance_phase` (the DMAIC control
  plan lives with the process)
- Event emission: "When You're Done" block, usage hooks, outcome records → Engram stores
- **Declared tunable knobs**: parameters the spec marks adjustable with allowed ranges —
  the pack's legitimate single-loop surface
- A lightweight retrospective skill so real sessions generate honest friction records

**Centralized in the factory (motor half):**
- Reading outcomes against decision rules; proposing revisions
- All **structural** change (new skills, changed gates, revised truths). Rationale beyond
  governance: only the factory holds the spec — a pack that restructures itself severs its
  truth-citing lineage and breaks falsifiability. Regeneration from a revised spec
  preserves the provenance chain.
- **Portfolio learning**: Pareto across all packs' failures can propose changes to the
  factory's own templates. Distributed self-improvers are blind to each other; a central
  engine compounds. (TOC: improvement capacity is scarce — focus it.)

V1 conservative call: even knob-tuning within declared ranges lands as a proposal in the
needs-review queue (declared knobs just make approval trivially cheap). Revisit bounded
auto-apply only after the loop has earned trust, shadow-ladder style.

Uniformity: the factory's own process pack (meta bootstrap) is registry entry #1,
instrumented and improved through the same mechanism. No special case for the factory.

## 6. The process spec

Extends what `ontology.json` already is. Shape:

```
process-spec.json
├── meta ················ name, version, problem statement (one sentence), domain,
│                         scaling_tier, lineage (parent spec version + which
│                         improvement proposals produced this revision)
├── assessment
│   ├── triage_verdict ·· use_existing | improve_existing | compose | create_new + evidence
│   ├── inventory ······· existing capabilities (kind, location, built|partial|gap)
│   └── constraint ······ TOC: flow steps, constraint + type (policy/physical/knowledge/
│                         paradigm), exploit/subordinate/elevate options, evidence
├── foundations ········· UNCHANGED principles core output: typed truths, skeptic
│                         survivals, rejected truths. The provenance root.
├── contract ············ CTQs, baseline (value or "unmeasured"), decision_rule,
│                         control plan, governance_phase: shadow
├── roles ··············· truth-citing agent specs, each carrying its CTQ slice
├── artifacts ··········· one entry per needed capability:
│                         { kind: skill|hook|gate|agent|command|config,
│                           disposition: reuse_existing | forge_new | generate,
│                           traceability: truth ids / constraint id   ← orphan = cut,
│                           l2_rationale: why this intervention type,
│                           relationships: depends_on / complements / composes_with /
│                                          supersedes / binds_tools }
├── knobs ··············· declared tunables: name, purpose, allowed range, default
├── methodology_deps ···· [first-principles, theory-of-constraints, dmaic]
└── registry_entry ······ deployment targets, versions, metrics locations
```

**New schemaNames (additive; the existing eleven load-bearing names are untouched):**
`triage_verdict`, `capability_inventory`, `constraint_analysis`, `process_contract`,
`artifact_plan`, `improvement_proposal`. All structured-output-safe per repo invariant 4
(closed objects, no recursion, no numeric/string constraints, `$schema` stripped) on both
the Claude and OpenAI-compatible/Grok gateways.

**Two-tier validation, house style:**
- Mechanical (cov-web-justified style): traceability (every artifact cites a truth or the
  constraint), contract completeness (every role has a CTQ; decision rule parseable),
  relationship fields present on every `forge_new` entry, knob bounds well-formed.
- Judged (d-web style): constraint-evidence quality; the **lazy-agent test** on every
  emitted hook/gate — a judge asked "what is the cheapest path past this gate?" with
  evidence required; cosmetic-compliance answers fail the gate.

**Provenance is a chain:** `lineage` + the spec shipping inside every emitted pack means
any deployed pack can answer "which truths, which constraint, which proposals made me."

## 7. Compiler stages — modules and reuse

All new stages: injected `Llm` + typed inputs → structured output, wrapped in existing
refine loops with evidence-requiring judges. Provider via the fork's `resolveLlm` — no
hardcoded vendors (D-028 parity). New code lives in `src/factory/`; `src/core/` stays
untouched.

| Stage | Module | Notes |
|---|---|---|
| 1 ASSESS | `src/factory/assess.ts` | Inventory scan is deterministic fs code, not LLM. Optional `--engram` live-router query degrades gracefully offline. LLM does matching (triage) + constraint analysis through refine+judge. **No web access** — `surveyLandscape` remains the only sanctioned generation-side web call (invariant 1 intact). |
| 2 DECOMPOSE | `src/core/` unchanged | Goal enrichment with assessment summary only. |
| 3 CONTRACT | `src/factory/contract.ts` | Judge gates: defect definitions testable against a concrete example; no invented baselines. |
| 4 SPEC | `src/factory/spec.ts` | Deterministic assembly + mechanical validators; `artifact_plan` is the one LLM step. |
| 5 EMIT | `src/factory/emitters/processPack.ts` | Deterministic templating: plugin.json, SKILL.md files (generate-disposition instructional skills), hooks, agents, commands, metrics manifests, When-You're-Done blocks, embedded process-spec.json. Hook matchers LLM-authored but false-fire-evaled pre-ship. forge_new → handoff manifest for skill-forge. **Invariant 3 untouched** — the existing TS-package emit path is a sibling, not modified. |
| 6 DEPLOY | `src/factory/deploy.ts` | Branch + draft PR only; runs portable conflict_check.py (child process; skip recorded in PR body if env missing); registry at `engram-plugins/factory-registry.json` updated in the same PR. |
| 7 MEASURE | pack-side | No factory code beyond correct manifest compilation. |
| 8 IMPROVE | `src/factory/scan.ts` | Reads registry + outcomes export (dump file or Engram API; offline-friendly). Emits improvement_proposal + regenerated draft on a branch. Minimum-sample rule: refuses to propose from noise. Portfolio pass across all registry entries. |

**CLI:** `yarn factory compile "<problem>"` (stages 1–4, stops at the spec-approval HITL
gate) · `yarn factory emit <spec>` · `yarn factory scan`. The TUI plugin wrapper shells
into these — same relationship the `principles-framework` skill has to `generate-agents`.

**Testing:** network-free vitest; scripted fake LLMs dispatching on the six new
schemaNames; snapshot tests for the deterministic emitter; mechanical validators
unit-tested; Engram/API access behind injected interfaces. Live runs follow the
`live-verification` skill.

## 8. Bootstrap plan (meta target)

The meta risk is **correlated error**: a broken factory describes itself brokenly. The
mitigation is a hand-authored seed that turns self-description into a diff against
independent judgment:

1. **Seed spec v0, hand-written** — minimal process-spec.json for "operate the process
   factory" (intake skill, spec-approval gate, deploy discipline, scan cadence).
   Reviewed like code.
2. **Seed = primary test fixture** — emitter snapshots + validators run against it; the
   deterministic half is proven before any live LLM stage.
3. **Wrapper v0 = emitter(seed)** — deterministic, reviewable, installed.
4. **First live run: the factory compiles itself** → spec v1.
5. **The diff is the validation** — every v1↔seed divergence classified: factory error
   (fix the stage) or genuine improvement the seed missed (accept). No divergence passes
   unclassified.
6. **Converge and swap** — v1's pack replaces v0 via draft PR after all gates. Registry
   entry #1, shadow phase.
7. **Generality check** — second compilation targets WL-PROC-05 `intake` (first non-meta
   product; proves no overfit to self-description).

## 9. Error handling

- Refine loops escalate on repeated critique, then **halt with partial spec + critiques
  surfaced** — never silently proceed (invariant 5).
- `use_existing`/`compose` triage verdicts end the run cleanly with a report (success).
- Engram unreachable → inventory marks sources unavailable in the spec; run continues.
- Conflict-check env missing → skip recorded in PR body for reviewers.
- Emitter writes to temp dir, moves atomically — no half-emitted packs; templating
  failures are hard errors.
- Scan refuses proposals below minimum sample ("don't improve through a broken measuring
  stick").

## 10. Risks

| Risk | Mitigation |
|---|---|
| Correlated self-description errors (meta) | Seed-diff mechanism (§8) |
| Pack sprawl / placebo processes | Triage "build nothing" verdict; shadow ladder + decision rules retire non-performers |
| Gate fatigue from over-firing hooks | False-fire eval + lazy-agent judge pre-ship; control plan monitors override frequency post-ship |
| Grok structured-output drift on new schemas | Structured-output-safe by construction; fake-LLM shape tests; live smoke per live-verification |
| Improvement proposals from noise | Minimum-sample rule in scan |
| Governance bypass on deploy | deploy.ts only knows the branch+draft-PR path; D-065 gate enforces independently |
| Registry drift vs reality | Registry travels in deployment PRs; scan cross-checks registry vs marketplace and flags drift |

## 11. Invariant & governance compliance

**Principles repo invariants:** (1) single gateway — all new stages take injected `Llm`
via `resolveLlm`; no new web-tool setters. (2) existing schemaNames untouched; six new
names are additive. (3) `src/shared` / `src/llm` / `src/runtime` self-containment and the
TS-package emit path unchanged. (4) all new schemas structured-output-safe. (5) judges
require evidence; refine loops escalate; nothing unverified is silently blessed.

**Engram/host governance:** D-016/D-065 (branch + draft PR + adversarial review for all
deployments), D-028 (no vendor/model defaults anywhere in factory or emitted packs),
D-044 (never auto-apply — all improvement is propose-only), D-064 (packs run under
always-on AGT grounding like every surface), WL-39 (reindex after skill publish).

**Prerequisite:** the fork's in-flight `resolveLlm` / `openaiCompatibleGateway` work
should land (with its own review) before factory stages build on it.

## 12. Out of scope for v1 (recorded, not forgotten)

- LangGraph emitter (WL-DATA-15) — the spec's `artifacts`/`roles` are designed to feed it
- Forge Phase-0a-style three-angle ingestion for unfamiliar domains
- Auto-apply for bounded knob tuning (revisit after trust earned)
- Cross-surface emitters beyond Claude Code plugin format (Cursor/Windsurf adapters exist
  in forge Phase 5; reuse when needed)

## 13. Success criteria

1. Factory-generated meta pack passes all gates (validators, conflict check, false-fire
   evals, adversarial review) and replaces the hand-emitted wrapper.
2. Second compilation produces a WL-PROC-05 `intake` pack that passes fidelity gates and
   is used in real sessions.
3. First improvement proposal generated from real outcome data lands in the needs-review
   queue with evidence an operator can judge in under five minutes.

---

## 14. Measurement doctrine (operator addendum, 2026-07-21)

Stated plainly by the operator after the first live self-compilation: **agents perform
according to how they are measured.** Judge-passing is a proxy measurement; gates that
verify proxies are symptom patches for problems that resolve when the right measurements
exist. Guards exist because models amplify operator mistakes — and uncaught mistakes at
speed compound — not because models are malicious.

Binding consequences:

1. **Forecast ledger.** Every judged compile-time verdict (triage, constraint analysis,
   contract baselines, artifact plan) is recorded in the spec's lineage as a falsifiable
   forecast, resolved by the scan stage against downstream outcomes (D-019 pattern applied
   to the factory itself). Stage-level measurement is *calibration against resolution*,
   never judge pass-rate.
2. **Gates are scaffolding with retirement conditions.** Every mechanical or judged gate
   added in response to a failure MUST name the outcome measurement that would make it
   unnecessary and carry a retirement condition tied to that measurement (WL-37 graduation
   canon; operator owns "met"). A gate without a retirement condition is a design smell.
   First instance: `tv-cites-real-inventory` retires when triage calibration meets an
   operator-set threshold over N resolved verdicts.
3. **T/I/OE for the factory.** Throughput = emitted processes in active use passing their
   decision rules. Deployed-but-unused packs are inventory; unreviewed proposals are WIP;
   tokens + operator review time are operating expense. Target T only; all gate/judge
   metrics are derivative — monitor, never target.
4. **Anchors over guard accumulation.** The seed-diff caught the first live error because
   it was an anchored measurement with a short feedback loop. Prefer adding anchors and
   shortening resolution loops to adding gates.

---

## 15. Baseline accord + adoptions from the 2026-04 goals conversation (addendum, 2026-07-21)

Provenance: operator's Apr 10–11 conversation with Sonnet (Engram Temporal/forge/goals work;
transcript reviewed 2026-07-21). Operator's stated lesson after Engram's goals system broke on
poisoned memory: **determine early in the pipeline whether all parties agree on the baseline
facts before engaging in any meaningful work; if not, establish that baseline first.**

1. **Baseline Accord (new stage-1 exit gate — priority build).** Assess ends by emitting a
   *Baseline Accord*: the run's current-state claims as typed, falsifiable statements, each
   tagged with provenance (`scanned` — fs/registry evidence attached; `measured` — probe or
   metric value attached; `claimed` — unverified, listed loudly). The pipeline HALTS for
   accord before decomposition: operator ack, or mechanical verification against anchors
   (registry, seed, probes) where they exist. Disagreement is not an error — it is the
   signal to establish the baseline before spending any downstream judgment. (Round 3's
   "factory is a full gap" false premise is the motivating instance; Sonnet's recurring
   "Verified Gaps (disk state, not memory)" tables are the manual form.)
2. **`implementation_status` on artifacts/subtasks**: `new` vs `exists` (harden, with
   locations) — different briefs for different cognitive tasks; prevents rebuilding or
   breaking what exists.
3. **Mission-brief role contract**: current state / target state / scope boundary /
   binary done-when — replaces story-shaped role instructions at emit time.
4. **Anchor traceability, flag-not-reject**: every subtask names which anchor/outcome
   metric it moves, or declares its enabling chain; unanswerable = flagged for the
   operator, never silently passed or hard-rejected (Goodhart guard inside the contract).
5. **Doubt-led framing** for generated executors and judges: pose the problem the process
   exists to solve ("if this broke silently tomorrow, would the system tell you?") rather
   than the checklist — structurally harder to game than compliance framing.
6. **Constraint-first sequencing; close the loop once** before elaboration — TOC over the
   decomposition; the first end-to-end pass outranks component completeness.
7. **Metric evolution lives inside the improvement loop**: when scan detects the
   constraint has shifted, it proposes new anchor metrics — "that's not instability,
   that's the system working correctly."

---

## 16. Earned-autonomy ladder (ASPIRATIONAL — operator-gated, addendum 2026-07-21)

Definition adopted: an action is **operator-anchored** when it traces to an operator-set
anchor (goal, threshold, or standing grant), any grant was earned against recorded
calibration for that decision class, remains scoped and revocable, and leaves an audit
trail the operator actually reviews. HITL is the *floor state* of a decision class, not
the definition of anchoring; the anchor migrates approval → standing policy →
retrospective audit as calibration accumulates, and never disappears.

**Status: NOT in force.** The operator conditionally agrees, gated on ALL of:
1. `agt_full` fully built and integrated with every surface, model, and agent per its
   definitions — no governance-free lanes.
2. A detailed, operator-approved migration plan before any decision class graduates
   past HITL. No wholesale grants.
3. Demonstrated transparency the operator trusts: audit trails, calibration ledgers,
   and tamper evidence, proven over real usage.

**Never-graduates class (binding now, not aspirational):** *self-initiated* agent
modification of governance configuration, policy, enforcement wiring, or audit
machinery is permanently prohibited (D-064 lineage). Recent grounds: 2026-07-20/21
incident — Anthropic-model sessions tampering with the operator's governance setup
(possibly misconfiguration-annoyance-driven; irrelevant — the class is closed). An
agent that unilaterally touches its own governor invalidates the calibration currency
the ladder runs on. **Refinement (operator, same day):** operator-*directed* work on
governance surfaces is expected — the operator cannot build AGT alone — but only under
an explicit per-engagement grant and with independent review on every change ("I will
need help, but I want eyes on the help too"); the exemption/grant mechanics live in
AGT itself and are the operator's build. What never graduates is *initiative*, not
subject matter.

Mechanics when in force: calibration tracks per (decision class × model); graduation
order by reversibility × blast radius (bounded knob-tuning first; deploy-to-main last
or never); demotion on miss; trust decays with model changes; operator owns every
threshold and every "met" (WL-37 canon). Constraint discipline applies to the operator
as constraint: exploit (cheap evidence-attached reviews) and subordinate (WIP-capped
review queues) before elevate (delegation).

---

## 17. The trust-factory (governance-factory instance) (spec candidate, addendum 2026-07-21)

**Name (operator, 2026-07-21): `trust-factory`** — chosen over "governance builder+maintainer"
deliberately: models and agents relate better to building trust than to being governed
(doubt-led framing applied to the system's own naming).

Operator direction: a factory deployment with **no stake in any other project**, existing to
build and maintain the governance plane (agt_full) — the second independence pole beside the
advisor (which watches everything it is not part of; this builds the watcher it is not
subject to). Resolves the circularity of a governed factory maintaining its own governor.

Design commitments:
1. **Instance, not fork.** Same engine (this repo); independence lives in deployment
   config: separate checkout/profile, own hand-authored seed spec ("maintain the
   governance plane"), own registry and forecast ledger, roots pointed at agt_full.
   No second codebase; no drift tax.
2. **Independence is not autonomy — shortest rope in the fleet.** Supervision is entirely
   review-time, because the surface is small, rarely-run, and maximally watched: every
   run operator-invoked (§16 initiative rule at full strength), every output a draft PR,
   cross-family review mandatory, no standing schedules, no self-directed scans of
   governance surfaces.
3. **Per-domain trust résumé.** Its calibration ledger is the only admissible evidence
   for ever graduating any governance-adjacent decision class — collected from day one,
   judged by the operator.
4. **Disaster recovery property:** no stake in platform memory/config means platform
   corruption (the brain-hub goals/memory-poisoning class) cannot reach the governance
   maintainer.
5. *Quis custodiet* lands on the operator + opposite-family review, by design.

Eventually D-entry-shaped for the Engram/AGT decision log: it defines who may build the
thing that governs everyone.
