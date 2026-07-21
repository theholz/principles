import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveProviderConfig } from "../../src/llm/resolveLlm";

/**
 * resolveProviderConfig is pure env-derived — each test clears every provider
 * variable up front and sets only what it needs; the developer's real values
 * are restored afterwards so no other test (or the dev shell) is polluted.
 */
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

describe("resolveProviderConfig", () => {
  it("defaults to xai with the Grok base URL, model grok-4.5, no key, not web-capable", () => {
    expect(resolveProviderConfig()).toEqual({
      provider: "xai",
      baseURL: "https://api.x.ai/v1",
      apiKey: undefined,
      model: "grok-4.5",
      webCapable: false,
    });
  });

  it("normalizes PRINCIPLES_PROVIDER (case + whitespace)", () => {
    process.env.PRINCIPLES_PROVIDER = "  GroK ";
    expect(resolveProviderConfig().provider).toBe("grok");
  });

  it("an unknown provider string falls through to the xai-shaped config (mirrors resolveDefaultLlm)", () => {
    process.env.PRINCIPLES_PROVIDER = "mystery";
    const cfg = resolveProviderConfig();
    expect(cfg.provider).toBe("mystery");
    expect(cfg.baseURL).toBe("https://api.x.ai/v1");
    expect(cfg.model).toBe("grok-4.5");
    expect(cfg.webCapable).toBe(false);
  });

  describe("xai key precedence: XAI_API_KEY ?? OPENAI_API_KEY ?? PRINCIPLES_API_KEY", () => {
    it("XAI_API_KEY wins over both fallbacks", () => {
      process.env.XAI_API_KEY = "xai-k";
      process.env.OPENAI_API_KEY = "oai-k";
      process.env.PRINCIPLES_API_KEY = "p-k";
      expect(resolveProviderConfig().apiKey).toBe("xai-k");
    });

    it("falls back to OPENAI_API_KEY, then PRINCIPLES_API_KEY", () => {
      process.env.OPENAI_API_KEY = "oai-k";
      process.env.PRINCIPLES_API_KEY = "p-k";
      expect(resolveProviderConfig().apiKey).toBe("oai-k");
      delete process.env.OPENAI_API_KEY;
      expect(resolveProviderConfig().apiKey).toBe("p-k");
    });
  });

  describe("openai", () => {
    beforeEach(() => {
      process.env.PRINCIPLES_PROVIDER = "openai";
    });

    it("defaults: api.openai.com base, model gpt-4.1, not web-capable", () => {
      process.env.OPENAI_API_KEY = "oai-k";
      expect(resolveProviderConfig()).toEqual({
        provider: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "oai-k",
        model: "gpt-4.1",
        webCapable: false,
      });
    });

    it("explicit key precedence: a stray XAI_API_KEY is NEVER used for openai", () => {
      process.env.XAI_API_KEY = "xai-k"; // must not leak to an OpenAI endpoint
      expect(resolveProviderConfig().apiKey).toBeUndefined();
      process.env.PRINCIPLES_API_KEY = "p-k";
      expect(resolveProviderConfig().apiKey).toBe("p-k");
      process.env.OPENAI_API_KEY = "oai-k";
      expect(resolveProviderConfig().apiKey).toBe("oai-k"); // OPENAI beats PRINCIPLES
    });

    it("PRINCIPLES_BASE_URL overrides the base for the openai provider", () => {
      process.env.PRINCIPLES_BASE_URL = "http://localhost:4000/v1";
      expect(resolveProviderConfig().baseURL).toBe("http://localhost:4000/v1");
    });
  });

  describe("claude / anthropic", () => {
    it("uses the Agent SDK shape: empty base URL, ANTHROPIC_API_KEY, claudeGateway's default model, web-capable", () => {
      process.env.PRINCIPLES_PROVIDER = "claude";
      process.env.ANTHROPIC_API_KEY = "ant-k";
      expect(resolveProviderConfig()).toEqual({
        provider: "claude",
        baseURL: "",
        apiKey: "ant-k",
        model: "claude-opus-4-8", // claudeGateway.ts default — keep in sync
        webCapable: true,
      });
    });

    it("the anthropic alias behaves identically and key may be absent (local claude login)", () => {
      process.env.PRINCIPLES_PROVIDER = "anthropic";
      const cfg = resolveProviderConfig();
      expect(cfg.provider).toBe("anthropic");
      expect(cfg.baseURL).toBe("");
      expect(cfg.apiKey).toBeUndefined();
      expect(cfg.webCapable).toBe(true);
    });
  });

  it("PRINCIPLES_MODEL overrides the model default on every provider", () => {
    process.env.PRINCIPLES_MODEL = "custom-model-1";
    for (const provider of ["xai", "openai", "claude"]) {
      process.env.PRINCIPLES_PROVIDER = provider;
      expect(resolveProviderConfig().model).toBe("custom-model-1");
    }
  });
});
