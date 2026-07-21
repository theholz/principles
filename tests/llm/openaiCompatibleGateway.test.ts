import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  makeOpenAiCompatibleLlm,
  makeGrokLlm,
} from "../../src/llm/openaiCompatibleGateway";

const fakeCreate =
  (content: string | null, capture?: { body?: any }) =>
  async (body: any) => {
    if (capture) capture.body = body;
    return {
      choices: [{ message: { content } }],
    } as any;
  };

describe("makeOpenAiCompatibleLlm", () => {
  it("returns the validated structured output", async () => {
    const llm = makeOpenAiCompatibleLlm({
      apiKey: "test",
      create: fakeCreate(JSON.stringify({ answer: "42" })),
    });
    const result = await llm({
      prompt: "q",
      schema: z.object({ answer: z.string() }),
      schemaName: "test",
    });
    expect(result).toEqual({ answer: "42" });
  });

  it("pins model and passes json_schema response_format", async () => {
    const capture: { body?: any } = {};
    const llm = makeOpenAiCompatibleLlm({
      apiKey: "test",
      model: "grok-4.5",
      create: fakeCreate(JSON.stringify({ a: "x" }), capture),
    });
    await llm({
      system: "sys",
      prompt: "user-q",
      schema: z.object({ a: z.string() }),
      schemaName: "typed_truths",
    });
    expect(capture.body.model).toBe("grok-4.5");
    expect(capture.body.messages[0].content).toBe("sys");
    expect(capture.body.response_format.type).toBe("json_schema");
    expect(capture.body.response_format.json_schema.name).toBe("typed_truths");
  });

  it("strips markdown fences before parse", async () => {
    const llm = makeOpenAiCompatibleLlm({
      apiKey: "test",
      create: fakeCreate("```json\n{\"a\":\"y\"}\n```"),
    });
    const result = await llm({
      prompt: "q",
      schema: z.object({ a: z.string() }),
      schemaName: "test",
    });
    expect(result).toEqual({ a: "y" });
  });

  it("retries on empty content then succeeds", async () => {
    let calls = 0;
    const llm = makeOpenAiCompatibleLlm({
      apiKey: "test",
      create: async () => {
        calls++;
        if (calls === 1) return { choices: [{ message: { content: null } }] } as any;
        return { choices: [{ message: { content: JSON.stringify({ a: "ok" }) } }] } as any;
      },
    });
    const result = await llm({
      prompt: "q",
      schema: z.object({ a: z.string() }),
      schemaName: "test",
    });
    expect(result).toEqual({ a: "ok" });
    expect(calls).toBe(2);
  });

  it("falls back to json_object when json_schema is rejected", async () => {
    let calls = 0;
    const formats: string[] = [];
    const llm = makeOpenAiCompatibleLlm({
      apiKey: "test",
      create: async (body) => {
        calls++;
        formats.push((body as any).response_format?.type);
        if (calls === 1) throw new Error("json_schema not supported");
        return {
          choices: [{ message: { content: JSON.stringify({ a: "fallback" }) } }],
        } as any;
      },
    });
    const result = await llm({
      prompt: "q",
      schema: z.object({ a: z.string() }),
      schemaName: "test",
    });
    expect(result).toEqual({ a: "fallback" });
    expect(formats).toEqual(["json_schema", "json_object"]);
  });

  it("retries schema-mismatch with a corrective turn instead of aborting", async () => {
    let calls = 0;
    const bodies: any[] = [];
    const llm = makeOpenAiCompatibleLlm({
      apiKey: "test",
      create: async (body) => {
        calls++;
        // Snapshot messages at call time — the gateway mutates the array between attempts.
        bodies.push({ ...body, messages: [...(body as any).messages] });
        // 1st reply parses as JSON but fails the schema (answer is a number)
        if (calls === 1)
          return { choices: [{ message: { content: JSON.stringify({ answer: 42 }) } }] } as any;
        return { choices: [{ message: { content: JSON.stringify({ answer: "42" }) } }] } as any;
      },
    });
    const result = await llm({
      prompt: "q",
      schema: z.object({ answer: z.string() }),
      schemaName: "typed_truths",
    });
    expect(result).toEqual({ answer: "42" });
    expect(calls).toBe(2);
    // The retry request must carry the bad reply + a corrective user turn naming the field
    const retryMessages = bodies[1].messages;
    expect(retryMessages.length).toBeGreaterThan(bodies[0].messages.length);
    const lastUserTurn = retryMessages[retryMessages.length - 1];
    expect(lastUserTurn.role).toBe("user");
    expect(lastUserTurn.content).toContain("answer");
  });

  it("throws after MAX_ATTEMPTS persistent schema failures (no infinite loop, no raw ZodError)", async () => {
    let calls = 0;
    const llm = makeOpenAiCompatibleLlm({
      apiKey: "test",
      create: async () => {
        calls++;
        return { choices: [{ message: { content: JSON.stringify({ answer: 42 }) } }] } as any;
      },
    });
    await expect(
      llm({
        prompt: "q",
        schema: z.object({ answer: z.string() }),
        schemaName: "typed_truths",
      })
    ).rejects.toThrow(/after 5 attempts.*Schema validation failed/s);
    expect(calls).toBe(5);
  });

  it("appends a corrective turn on unparseable JSON before retrying", async () => {
    let calls = 0;
    const bodies: any[] = [];
    const llm = makeOpenAiCompatibleLlm({
      apiKey: "test",
      create: async (body) => {
        calls++;
        bodies.push({ ...body, messages: [...(body as any).messages] });
        if (calls === 1)
          return { choices: [{ message: { content: "Sure! Here is the JSON you asked for: {broken" } }] } as any;
        return { choices: [{ message: { content: JSON.stringify({ a: "ok" }) } }] } as any;
      },
    });
    const result = await llm({
      prompt: "q",
      schema: z.object({ a: z.string() }),
      schemaName: "test",
    });
    expect(result).toEqual({ a: "ok" });
    const retryMessages = bodies[1].messages;
    expect(retryMessages[retryMessages.length - 1].content).toMatch(/not parseable JSON/);
  });

  it("warns but continues when webTools is requested", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = makeOpenAiCompatibleLlm({
      apiKey: "test",
      create: fakeCreate(JSON.stringify({ a: "x" })),
    });
    await llm({
      prompt: "q",
      schema: z.object({ a: z.string() }),
      schemaName: "agent_output",
      webTools: true,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("makeGrokLlm", () => {
  it("defaults to grok-4.5", async () => {
    const capture: { body?: any } = {};
    const llm = makeGrokLlm({
      apiKey: "test",
      create: fakeCreate(JSON.stringify({ ok: true }), capture),
    });
    await llm({
      prompt: "q",
      schema: z.object({ ok: z.boolean() }),
      schemaName: "test",
    });
    expect(capture.body.model).toBe("grok-4.5");
  });
});
