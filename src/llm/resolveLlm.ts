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
  // KEEP IN SYNC with resolveProviderConfig below: same provider branches,
  // same base URLs, same key precedence per provider, same model defaults.
  const provider = providerFromEnv();
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
        // Explicit precedence: never let a stray XAI_API_KEY (the gateway's
        // first fallback) be sent to an OpenAI endpoint. Empty string (not
        // undefined) so the gateway's missing-key error fires instead of its
        // XAI_API_KEY fallback when no OpenAI key is set.
        apiKey: process.env.OPENAI_API_KEY ?? process.env.PRINCIPLES_API_KEY ?? "",
      });

    case "xai":
    case "grok":
    default:
      warnIfMissing(["XAI_API_KEY", "PRINCIPLES_API_KEY"], "xAI Grok API");
      return makeGrokLlm(model ? { model } : {});
  }
}

/**
 * Whether the resolved default provider supports LlmRequest.webTools
 * (Claude WebSearch/WebFetch). The OpenAI-compatible gateway soft-degrades
 * webTools; callers whose output integrity DEPENDS on live web (landscape
 * survey citations, the bench bare-model arm) must consult this and skip or
 * refuse rather than silently degrade.
 */
export function providerSupportsWebTools(): boolean {
  const provider = providerFromEnv();
  return provider === "claude" || provider === "anthropic";
}

/** Pure env-derived view of the provider selection, for introspection verbs
 * (e.g. `factory models`) that need the endpoint + key without constructing
 * a gateway. */
export interface ProviderConfig {
  /** Normalized PRINCIPLES_PROVIDER (lowercased, trimmed; default "xai").
   * Unknown values keep their raw normalized string but resolve to the
   * xai-shaped config, mirroring resolveDefaultLlm's default branch. */
  provider: string;
  /** OpenAI-compatible base URL; "" for the Claude Agent SDK (no REST base). */
  baseURL: string;
  /** Resolved key per the provider's precedence chain; undefined when unset. */
  apiKey: string | undefined;
  /** PRINCIPLES_MODEL, else the provider's gateway default. */
  model: string;
  /** Whether LlmRequest.webTools is honored (Claude gateway only). */
  webCapable: boolean;
}

/**
 * KEEP IN SYNC with resolveDefaultLlm above — this mirrors its branch logic
 * (and the gateways' own env fallbacks) without side effects:
 *   claude/anthropic → Agent SDK; ANTHROPIC_API_KEY; default model
 *                      "claude-opus-4-8" (claudeGateway.ts default)
 *   openai           → PRINCIPLES_BASE_URL ?? api.openai.com/v1; explicit key
 *                      precedence OPENAI_API_KEY ?? PRINCIPLES_API_KEY (never
 *                      a stray XAI_API_KEY); default model "gpt-4.1"
 *   xai/grok/default → PRINCIPLES_BASE_URL ?? api.x.ai/v1; key XAI_API_KEY ??
 *                      OPENAI_API_KEY ?? PRINCIPLES_API_KEY (the
 *                      openaiCompatibleGateway fallback chain); default model
 *                      "grok-4.5"
 * Not folded into resolveDefaultLlm because that function's behavior hangs on
 * subtleties this view flattens (the openai branch's ""-not-undefined key
 * sentinel; passing {} vs an explicit default model to the Claude gateway).
 */
export function resolveProviderConfig(): ProviderConfig {
  const provider = providerFromEnv();
  const model = process.env.PRINCIPLES_MODEL;

  switch (provider) {
    case "claude":
    case "anthropic":
      return {
        provider,
        baseURL: "",
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: model ?? "claude-opus-4-8",
        webCapable: true,
      };

    case "openai":
      return {
        provider,
        baseURL: process.env.PRINCIPLES_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: process.env.OPENAI_API_KEY ?? process.env.PRINCIPLES_API_KEY,
        model: model ?? "gpt-4.1",
        webCapable: false,
      };

    case "xai":
    case "grok":
    default:
      return {
        provider,
        baseURL: process.env.PRINCIPLES_BASE_URL ?? "https://api.x.ai/v1",
        apiKey:
          process.env.XAI_API_KEY ??
          process.env.OPENAI_API_KEY ??
          process.env.PRINCIPLES_API_KEY,
        model: model ?? "grok-4.5",
        webCapable: false,
      };
  }
}

function providerFromEnv(): string {
  return (process.env.PRINCIPLES_PROVIDER ?? "xai").toLowerCase().trim();
}

function warnIfMissing(keys: string | string[], label: string): void {
  const list = Array.isArray(keys) ? keys : [keys];
  if (list.some((k) => !!process.env[k])) return;
  console.warn(
    `${list.join(" / ")} is not set — ${label} calls will fail until a key is available.`
  );
}
