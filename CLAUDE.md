# Principles Framework — Project Instructions

Agent-generation framework: compiles a goal into typed, adversarially-vetted truths → truth-citing subtasks → an `ontology.json` + generic runtime package. No codegen. Plans that built this: `docs/superpowers/plans/`.

## Invariants (violating any of these breaks tests or production)

1. **Single LLM gateway.** Every model call goes through the `Llm` function type in `src/llm/gateway.ts`, implemented only by the gateways in `src/llm/`: `makeClaudeAgentSdkLlm` (`claudeGateway.ts`, Claude Agent SDK) and `makeOpenAiCompatibleLlm`/`makeGrokLlm` (`openaiCompatibleGateway.ts`, OpenAI-compatible chat APIs). Provider selection for CLI entry points lives in `resolveLlm.ts` (`PRINCIPLES_PROVIDER`; this fork's default is xAI Grok, model `grok-4.5`). Never import `@anthropic-ai/claude-agent-sdk` or `openai` outside `src/llm/`; never add other raw-API clients (`@anthropic-ai/sdk`). Gateway calls are tool-less except per-call web tools (WebSearch/WebFetch, Claude gateway only — the OpenAI-compatible gateway soft-degrades `webTools` with a console warning and continues) granted via `LlmRequest.webTools` — set only by runtime evaluator agents whose subtask's web request survived judging, plus the benchmark harness's bare-model baseline arm (`src/bench/`, deliberately unmachined; its `--exec-model` flag may also run the principles arm's *execution phase* on a smaller Claude model — generation always stays on the default model) and `src/core/survey.ts` (`surveyLandscape`, the one sanctioned generation-side web call — it surveys the world, not the objective); the rest of the generation pipeline (truths, skeptic, decomposition, judging, specs, rubrics) never sets it.
2. **schemaName strings are load-bearing.** `typed_truths`, `truth_attack`, `decomposition`, `rubric_verdicts`, `rubric_guidance`, `rubric_revision`, `agent_spec`, `triage_plan`, `agent_output`, `synthesis`, `direct_answer`, `landscape_survey`, `frame_challenges`, `bench_report` — the test suite's scripted fakes dispatch on these exact strings. Renaming one silently breaks pipeline tests.
3. **Emitted packages copy source verbatim.** `src/core/emit.ts` copies `src/shared/`, `src/llm/`, `src/runtime/` into every generated package. Those three directories must stay self-contained: no imports from `src/core/` or `src/scripts/`, and any new dependency they use must be added to the mirrored-deps list in `emit.ts`.
4. **Schemas must be structured-output-safe.** Closed objects (`additionalProperties: false` via `zodToJsonSchema` target `openAi`), no recursion, no numeric/string constraints — and never let a `$schema` meta-key through (the Agent SDK CLI silently skips structured output when present; the gateway strips it, keep it that way).
5. **Mechanisms stay falsifiable.** Judges must require evidence (enforced in code in `src/shared/judge.ts`); refine loops must feed critiques back and escalate on repeats (`src/shared/refine.ts`); non-converged agent output must surface in `RunResult.unverified`, never be silently blessed. Web access must be proposed with a justification at decomposition and is enforced by `cov-web-justified` (mechanical) and `d-web` (judged).

## Commands

- `yarn build` — tsc (must stay green)
- `yarn test` — vitest (unit tests are network-free; all LLM callers take an injected `Llm`, tests pass fakes)
- `yarn generate-agents "<goal>"` — full live pipeline (many Opus calls, costs money; see the `live-verification` skill first)
- `yarn compile-rubric "<goal>"` — compile a gradeable rubric only (foundations, no agent specs; see the `live-verification` skill for run guidance)
- `yarn judge-diff` — grade a diff against `.github/review-rubric.json` (advisory; CI posts it on PRs). Regenerate the rubric with `yarn compile-rubric` and copy `rubric.json` over `.github/review-rubric.json` when invariants change.
- `yarn research-pilot` — benchmark harness (fetch/run/status): bare model vs compiled teams on ResearchRubrics; results + protocol in `benchmarks/research-pilot/`.

## Auth

Default provider (xAI Grok): `XAI_API_KEY` in `.env` (see `.env.example`; `scripts/with-xai-env.sh` loads it). Claude provider (`PRINCIPLES_PROVIDER=claude`): `ANTHROPIC_API_KEY` or a local `claude` login. OpenAI-compatible: `OPENAI_API_KEY` / `PRINCIPLES_API_KEY` + `PRINCIPLES_BASE_URL`. Missing key is a warning, not an error — keep it that way.
