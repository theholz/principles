# Business-process spec v0.2 — todo-plane routing (HITL gate proposal)

**Branch:** `factory/todo-plane-v02` · **File:** `seeds/business-process/process-spec.json` (0.1.0 → 0.2.0)
**Gate:** v0.1 was operator-approved at the HITL gate (afc2861); this amendment changes steward behavior, so it goes back through the gate — propose, don't bypass.
**Tracked as:** Vikunja task #3 (`wl:48`, Platform project) · engram WL-48 row (truth-up 98d891ce)

## Why

The v0.1 spec predates adoption of the D-052/D-062 todo plane and contains zero mentions of Vikunja or the TodoBridge. Worse, the intake-steward brief mandated "exactly one WORKLIST.md row … no parallel todo ledgers on any surface — consolidate toward the declared home," which would train the stewards to consolidate the Vikunja plane *away* — the inverse of D-052 (WORKLIST = platform meta; Vikunja = day-to-day + agent work) and of NORTH-STAR's standing rule ("WORKLIST row **or** Vikunja todo + todo_dispatch").

The bridge itself is live and proven (slices A–C + E-core, D-062 write-back), and the instance was seeded 2026-07-22: projects Platform / Dev / Trading / Governance (trust-factory) + `ws:`/`src:`/`wl:` labels, WL-48 remaining slices filed as `wl:48` tasks. What was missing is process adoption — this amendment is that wiring.

## What changes

| Piece | Change |
|-------|--------|
| **t9** (new truth, constraint) | Dual-ledger doctrine: WORKLIST.md = platform-meta (D-015); Vikunja via TodoBridge = day-to-day + dispatchable (D-052/D-062); `wl:NN` cross-links; item in both without a link, or in neither, is a defect |
| **t10** (new truth, constraint) | Trust-factory carve-out: Governance-project tasks are operator-invoked only — never `todo_dispatch`, never coding_lane (design §17, D-029); trust-factory runs may write evidence back |
| **ctq6** (new CTQ) | Adoption + congruence: ≥70% of qualifying dispatched runs originate from a Vikunja task with run/PR write-back within two sweep windows; routing defects decline sweep-over-sweep |
| **vikunja-todobridge** (new artifact, reuse_existing) | The shipped tool lane (`todo_*` LC tools, `/api/todos/*`, `agent/todos/`), bound as reuse — never reimplement |
| **intake-steward** | TARGET STATE / step 3 / CANONICAL HOMES / DONE-WHEN rewritten: route by plane; Vikunja is a declared home, not a parallel ledger |
| **implement-steward** | Step 6 amended + step 7 added: update the source ledger; dispatch Vikunja-tracked work via `todo_dispatch`; verify write-back; never dispatch Governance tasks |
| **capture-steward** | Step 3: day-to-day routing corrected to Vikunja; completion evidence via `todo_comment` |
| **accord-sweeper** | New step 7: todo-plane congruence sweep (`wl:` label ↔ WL row; write-backs present; Governance dispatch = hard finding); sweep repairs congruence, never consolidates the plane away |
| Roles | `servesTruths`/`ctqIds` bumped accordingly (capture-steward: t9 only) |

## Trust-factory involvement

Beyond the t10 carve-out: when the trust-factory instance's seed spec is authored (§17 spec candidate), its work queue is the Governance project in the same Vikunja SoT — visibility without autonomy. Its runs write evidence back onto tasks like any other client, but only the operator pulls the trigger.

## Receipts

- Factory mechanical validators (validateProcessSpec): **4/4 pass** (pv-traceability, pv-contract-complete, pv-forge-relationships, pv-knob-bounds)
- `yarn vitest run tests/factory`: **219/219 pass**
- Schema round-trip via `loadProcessSpec`: OK (10 truths · 6 CTQs · 25 artifacts)
- Diff is surgical: 67 insertions / 12 deletions, original formatting preserved

## Gate ask

1. Approve v0.2 → merge branch; recompile/redeploy the process pack via `yarn factory` so the deployed steward skills pick up the routing.
2. Or amend at the gate — the falsifiable pieces to challenge are t9's "exactly one of two ledgers" boundary and ctq6's 70% spec limit.

## Out of scope

- Slice I (`todo_relate` dependencies) — engram plan `2026-07-22-vikunja-relations-slice-i.md`, Vikunja task #2
- Trust-factory seed spec authoring (§17 remains a spec candidate)
- Any change to WORKLIST.md's role for platform meta (D-015 untouched)
