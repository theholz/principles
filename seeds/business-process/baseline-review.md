# Operator verification sheet — business-process baseline inventory

Companion to `business-process-baseline.json` (56 entries: 49 built, 2 partial, 5 gap).
Every built/partial receipt was verified by direct Read/Grep/ls/docker/curl on 2026-07-21.
Rows marked **LOW CONF** are where the operator should look hardest.

## Tier A — full scope: engram (25)

| Name | Status | Receipt | Why it matters to the processes |
|---|---|---|---|
| engram-stack-running | built | docker ps: brain-api Up 5h (healthy) :8093 | The substrate is live, not aspirational — processes bind to running services |
| coding-lane-pipeline | built | agent/coding_lane/graph.py:1 | The one shipped end-to-end lane; the model for every other phase pack |
| coding-lane-fidelity-gates | built | agent/coding_lane/fidelity.py:1 (WL-GOV-03) | Deterministic plan/implement gates — reuse the pattern, don't reinvent |
| coding-lane-process-pack | built | agent/coding_lane/process_pack.py:1 | Deterministic skill binding precedent (WL-PROC-05 rule) |
| coding-lane-daytona-sandbox | built | agent/coding_lane/sandbox.py:1 (D-039) | Implement-process execution plane |
| d065-adversarial-review-gate | built | .claude/hooks/check_adversarial_review.sh:2 | Review process is already ENFORCED at commit time |
| adversarial-review-receipt-cli | built | bin/record-adversarial-review:2 | Receipt producer the review process composes with |
| governance-context-inheritance | built | agent/governance/context.py:1 (D-024) | Child agents inherit process/governance context by construction |
| process-improvement-scan | built | agent/routes/workflow.py:50 | Improve-loop trigger already shipped (WL-PROC-06) |
| needs-review-queue | built | agent/routes/workflow.py:40 | Attention queue where process failures land |
| workflow-registry-eval | built | agent/routes/workflow.py:7 (import line) — **LOW CONF**: service internals not read | Measure-loop data plane (record/query/promote) |
| retrospective-cadence-check | built | agent/services/retrospective_cadence.py:1 (D-043/WL-45) | Capture-process trigger; deliberately not an author |
| pr-cross-family-review | built | agent/services/pr_cross_family_review.py:1 (D-054) | Review routing between model families |
| session-start-advisory | built | .claude/hooks/session_start_advisory.sh:2 | Intake: session opens with state + D-066 banner |
| session-start-memory-projection | built | .claude/hooks/session_start_memory_projection.sh:2 (WS3/D-053) | Retro/capture must write where sessions read |
| memory-ingest-router | built | agent/memory_ingest.py:1 | Single provenance-bearing write path for capture |
| memory-distill-ingest-guards | built | agent/memory_distill/ingest_guards.py:1 | Guarded-capture pattern (deterministic rejects) |
| ingestion-kill-switch | built | agent/ingestion_gate.py:1 | Pause control every scheduled process must respect |
| temporal-deep-agent-worker | built | docker ps deep-agent-worker + worker.py:1 | Durable scheduled-process home already running |
| orchestrator-log-discipline | built | operator-notes/ORCHESTRATOR-LOG.md:3 (D-058) | Gate notes SoT the processes write into |
| phase-status-discipline | built | operator-notes/PHASE-STATUS.md:3 | Phase reporting SoT |
| shared-operator-sot | built | docs/superpowers/WORKLIST.md:25 (WL-PROC-05) | D-015 shared state; the engagement's own charter row |
| processes-doc | built | docs/PROCESSES.md:139 | The lived manual the compile must compose with |
| skill-router | partial | agent/tools/skill_router.py:2 | Deprecated for process flows — discovery only; a triage trap if misread as the binding mechanism |
| retrospectives-corpus | built | ls retrospectives/ → 2026-07-18 files | Cadence check's input corpus exists and is fresh |

## Tier A — full scope: agt_full (10)

| Name | Status | Receipt | Why it matters to the processes |
|---|---|---|---|
| agt-stack-running | built | docker ps: agt_full-governance-advisor-1 Up 5h :8095 | Governance plane is live |
| governance-advisor-service | built | curl :8095/health → status ok, scope_count 18 | The may-I-act authority for every process |
| agt-grounding-sensor | built | routes/grounding.py:35 POST /sensor | Deterministic claim verification for review/capture |
| agt-enforce-gate | built | routes/enforce.py:59 POST /evaluate | Per-surface enforcement primitive |
| agent-surfaces-registry | built | policies/agent-surfaces-registry.yaml:26 | Identity axis for "process constant, enforcement calibrated" |
| control-plane-state | built | scopes.json version 2, updated 2026-07-21 | Standing-permission home; live as of today |
| agt-flight-recorder | built | wc -l → 95285 lines | Audit substrate an accord sweep would read |
| agt-policy-pack | built | policies/governance.yaml:1 — **LOW CONF**: grouped entry, only governance.yaml header read; other policy files verified by ls only | Policy corpus the processes must not contradict |
| retrospective-gate-policy | built | policies/retrospective-gate.yaml:1 (ALWAYS ENFORCE) | Hard-gate twin of engram's advisory cadence — capture already dual-plane enforced |
| verdict-watchdog | built | docker ps agt_full-verdict-watchdog-1 Up + src dir — **LOW CONF**: role/behavior not audited | Companion enforcement service; unknown coupling to processes |

## Tier A — full scope: factory pack + plugins (7)

| Name | Status | Receipt | Why it matters to the processes |
|---|---|---|---|
| process-factory-meta-pack | built | process-spec.json:5 problemStatement | The factory operates itself via a deployed pack — proof of the emission path |
| factory-registry | built | factory-registry.json:3 — **LOW CONF**: only the name grepped; full schema not validated | Where the new business-process pack must register |
| factory-intake-skill | built | skills/factory-intake/SKILL.md:2 | Intake procedure already shipped for factory ops — compose, don't duplicate |
| spec-approval-gate-stub | partial | gates/spec-approval-gate.md:3 "Not live gate code" | Gate emission works; gate ENFORCEMENT is contract-only — honest partial |
| skill-forge-plugin | built | skills/skill-forge/SKILL.md:2 | The only sanctioned skill-output handoff (WL-PROC-05) |
| methodologies-plugin | built | ls skills → dmaic, first-principles, toc, persona-interview | Improvement methods to bind into improve/retro processes |
| dev-workflow-plugin | built | ls skills → feature-framework, definition-of-done, gitnexus, ... | Direct plan/review process inputs |

## Tier B — interface services (9)

| Name | Status | Receipt | Governing discipline / why |
|---|---|---|---|
| litellm | built | curl :4040 liveliness "I'm alive!" + docker Up (healthy) | D-025 request-queue discipline; D-028 role-based model access |
| infisical | built | docker ps infisical Up :8086 | WL-SECRETS-01 secrets SoT |
| langfuse | built | docker ps langfuse-web Up :3100 | Observability — process metrics manifests |
| n8n | built | docker ps n8n Up (healthy) :5678 | Scheduling — future scan-cadence home |
| temporal | built | docker ps temporal Up (healthy) :7233 | Durable workflows (deep-agent queue live) |
| daytona | built | docker ps daytona-api Up (healthy) :3986 | D-029/D-039 sandbox execution |
| postgres-supabase | built | docker ps supabase-db Up (healthy) :5432 | D-053 brain SoT; workflow_registry lives here |
| neo4j | built | docker ps neo4j Up (healthy) :7474/:7687 | Graph store |
| qdrant | built | docker ps agt_full-qdrant-1 Up :6333 — **LOW CONF**: only instance is under the agt_full compose project; engram-side usage unconfirmed | Vector store |

## Tier C — known gaps (5)

| Name | Status | Receipt | Why it matters |
|---|---|---|---|
| multi-agent-working-copy-protocol | gap | (note carries verified reflog line: HEAD@{120} fb46dc6e "reset: moving to origin/main") | The 2026-07-21 incident class the processes must close |
| scheduled-graded-memory-scoring | gap | — | In AGT shadow migration; named trust-factory candidate |
| general-reviewed-proposal-pipeline | gap | — **LOW CONF**: operator cited "WL-28 open" but WORKLIST.md:87 WL-28 is the core_memory Coach-loop gate (D-026), a specific instance — confirm the intended reference | Reviewed-proposal mechanism exists nowhere in general form |
| business-process-definitions | gap | — | The engagement target; only the implement lane (coding_lane) exists |
| accord-sweep-automation | gap | — | D-067 (DECISIONS.md:16) mechanism with no automation; substrate (flight recorder, retro gates) exists |

## Where to look hardest (all LOW CONF rows)

1. **general-reviewed-proposal-pipeline** — the WL-28 citation does not match the current WORKLIST row text; if the operator meant a different WL item, fix the note before compile.
2. **verdict-watchdog** — container Up and source tree present, but I did not read what it watches; if it already enforces something process-shaped, triage could double-count a gap.
3. **workflow-registry-eval** — receipt is the route's import line; the promote_tier/query_constraints semantics were not read.
4. **qdrant** — the single running instance is agt_full's; whether engram's skill/memory vector paths point at it (or are dormant since the skill-push disable) is unverified.
5. **agt-policy-pack / factory-registry** — grouped/lightly-verified entries: individual policy files beyond governance.yaml were existence-checked only; factory-registry.json was grepped for the one entry, not schema-validated.

## Amendments from operator feedback (2026-07-21)

| Entry | Change |
|---|---|
| langfuse / agt-flight-recorder | noted: scoring orchestration between them IN PROGRESS — target integration for process measure-stages |
| governance-advisor-service | OPERATIVE TRUTH noted: implemented = default Microsoft product + augmentations; coach/trust docs are conflicting intent-tier |
| coach-loop-autonomy-parallel-eval | NEW gap: parked parallel-eval intent; operator leaning to default product until second governance product gets time |
| canonical-operator-plane | NEW gap: duplicate operator planes (operator-copilot vs operator-notes vs superpowers root vs docs root) — live §18.1 violation, consolidation required |
| governance-process-templates | NEW reference (partial): 24 operator templates at ~/Documents/trading/docs/governance/templates — retrospective/change-control/rule-change/error-pattern map onto capture/review/propose/improve |
