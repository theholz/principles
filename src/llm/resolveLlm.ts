import { Llm } from "./gateway";
import { makeClaudeAgentSdkLlm } from "./claudeGateway";
import { makeGrokLlm, makeOpenAiCompatibleLlm } from "./openaiCompatibleGateway";

/**
 * Provider selection for CLI entry points.
 *
 * PRINCIPLES_PROVIDER:
 *   - "xai" | "grok" (default) → xAI OpenAI-compatible API
 *   - "openai"                 → OpenAI (or PRINCIPLES_BASE_URL)
 *   - "claude" | "anthropic"   → Claude Agent SDK (original)
 *
 * Auth:
 *   xai/grok  → XAI_API_KEY
 *   openai    → OPENAI_API_KEY or PRINCIPLES_API_KEY
 *   claude    → ANTHROPIC_API_KEY or local claude login
 *
 * Model override: PRINCIPLES_MODEL (default grok-4.5 for xai)
 * Base URL:       PRINCIPLES_BASE_URL
 */
export function resolveDefaultLlm(modelOverride?: string): Llm {
  const provider = (process.env.PRINCIPLES_PROVIDER ?? "xai").toLowerCase().trim();
  const model = modelOverride ?? process.env.PRINCIPLES_MODEL;

  switch (provider) {
    case "claude":
    case "anthropic":
      warnIfMissing("ANTHROPIC_API_KEY", "Claude Agent SDK / local claude login");
      return makeClaudeAgentSdkLlm(model ? { model } : {});

    case "openai":
      warnIfMissing(["OPENAI_API_KEY", "PRINCIPLES_API_KEY"], "OpenAI-compatible API");
      return makeOpenAiCompatibleLlm({
        baseURL: process.env.PRINCIPLES_BASE_URL ?? "https://api.openai.com/v1",
        model: model ?? "gpt-4.1",
      });

    case "xai":
    case "grok":
    default:
      warnIfMissing(["XAI_API_KEY", "PRINCIPLES_API_KEY"], "xAI Grok API");
      return makeGrokLlm(model ? { model } : {});
  }
}

function warnIfMissing(keys: string | string[], label: string): void {
  const list = Array.isArray(keys) ? keys : [keys];
  if (list.some((k) => !!process.env[k])) return;
  console.warn(
    `${list.join(" / ")} is not set — ${label} calls will fail until a key is available.`
  );
}
