import OpenAI from "openai";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Llm, LlmRequest } from "./gateway";

export interface OpenAiCompatibleGatewayOptions {
  /** Model id, e.g. "grok-4.5" or "grok-4.20". */
  model?: string;
  /** Base URL for an OpenAI-compatible API. Default: xAI. */
  baseURL?: string;
  /** API key. Default: XAI_API_KEY, then OPENAI_API_KEY. */
  apiKey?: string;
  /**
   * Injectable chat.completions.create for tests.
   * Signature matches the subset we use.
   */
  create?: (
    body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
  ) => Promise<OpenAI.Chat.ChatCompletion>;
}

const DEFAULT_SYSTEM =
  "You are a precise assistant. Produce only the requested structured data.";

const MAX_ATTEMPTS = 5;

/**
 * Llm implementation for OpenAI-compatible chat APIs (xAI Grok, OpenAI, LiteLLM, …).
 * Structured output via response_format json_schema; falls back to json_object + parse.
 *
 * webTools is not supported on this gateway (no Claude WebSearch/WebFetch). Calls with
 * webTools=true still run, but without live search — the pipeline continues.
 */
export function makeOpenAiCompatibleLlm(opts: OpenAiCompatibleGatewayOptions = {}): Llm {
  const model = opts.model ?? process.env.PRINCIPLES_MODEL ?? "grok-4.5";
  const baseURL =
    opts.baseURL ?? process.env.PRINCIPLES_BASE_URL ?? "https://api.x.ai/v1";
  const apiKey =
    opts.apiKey ??
    process.env.XAI_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.PRINCIPLES_API_KEY;

  const create =
    opts.create ??
    (() => {
      if (!apiKey) {
        throw new Error(
          "No API key for OpenAI-compatible gateway. Set XAI_API_KEY (or PRINCIPLES_API_KEY / OPENAI_API_KEY)."
        );
      }
      const client = new OpenAI({ apiKey, baseURL });
      return (body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming) =>
        client.chat.completions.create(body);
    })();

  return async <T>({ system, prompt, schema, schemaName, webTools }: LlmRequest<T>): Promise<T> => {
    if (webTools === true) {
      // Soft degrade: Claude's WebSearch/WebFetch are not available here.
      // Pipeline stages that set webTools still get a structured completion.
      console.warn(
        `[openaiCompatibleGateway] webTools requested for "${schemaName}" but this gateway has no web tools — continuing without them`
      );
    }

    const jsonSchema = zodToJsonSchema(schema as any, { target: "openAi" }) as Record<
      string,
      unknown
    >;
    delete jsonSchema["$schema"];

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system ?? DEFAULT_SYSTEM },
      {
        role: "user",
        content:
          prompt +
          `\n\nRespond with a single JSON object matching the schema named "${schemaName}". No markdown fences, no commentary.`,
      },
    ];

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Prefer strict json_schema; some endpoints only accept json_object.
        let completion: OpenAI.Chat.ChatCompletion;
        try {
          completion = await create({
            model,
            messages,
            temperature: 0,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: schemaName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "result",
                schema: jsonSchema,
                strict: false,
              },
            },
          });
        } catch (schemaErr) {
          // Fallback: json_object mode
          lastError =
            schemaErr instanceof Error ? schemaErr : new Error(String(schemaErr));
          completion = await create({
            model,
            messages,
            temperature: 0,
            response_format: { type: "json_object" },
          });
        }

        const text = completion.choices[0]?.message?.content;
        if (!text) {
          lastError = new Error(
            `OpenAI-compatible API returned empty content for schema "${schemaName}"`
          );
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(stripCodeFences(text));
        } catch (parseErr) {
          lastError = new Error(
            `Failed to parse JSON for schema "${schemaName}": ${
              parseErr instanceof Error ? parseErr.message : String(parseErr)
            }`
          );
          continue;
        }

        return schema.parse(parsed);
      } catch (err) {
        // zod failures after a successful parse should not retry — surface immediately
        if (err && typeof err === "object" && "name" in err && (err as any).name === "ZodError") {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new Error(`after ${MAX_ATTEMPTS} attempts, ${lastError!.message}`);
  };
}

/** Convenience factory pinned to xAI defaults. */
export function makeGrokLlm(
  opts: Omit<OpenAiCompatibleGatewayOptions, "baseURL"> & { baseURL?: string } = {}
): Llm {
  return makeOpenAiCompatibleLlm({
    baseURL: opts.baseURL ?? process.env.PRINCIPLES_BASE_URL ?? "https://api.x.ai/v1",
    model: opts.model ?? process.env.PRINCIPLES_MODEL ?? "grok-4.5",
    apiKey: opts.apiKey,
    create: opts.create,
  });
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}
