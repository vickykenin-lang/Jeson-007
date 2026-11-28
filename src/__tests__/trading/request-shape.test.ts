/**
 * Request shape sent to the LLM: OpenAI-compatible providers such as Gemini
 * reject a request with no user message ("400 contents is not specified").
 */

import crypto from "crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { runAgentLoop } from "../../agent/loop.js";
import { buildContextMessages, normalizeMessagesForInference } from "../../agent/context.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { setLedgerSealKey } from "../../trading/ledger.js";
import { resolveTradingConfig } from "../../trading/types.js";
import type { AgentTurn, AutomatonDatabase, ChatMessage, InferenceOptions, InferenceResponse } from "../../types.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
  toolCallResponse,
} from "../mocks.js";

beforeAll(() => setLedgerSealKey(crypto.randomBytes(32)));
afterAll(() => setLedgerSealKey(null));

/** Fails like Gemini: only system messages → 400. Optionally fails the first N calls anyway. */
class GeminiLikeInference extends MockInferenceClient {
  constructor(responses: InferenceResponse[], private failFirst = 0) {
    super(responses);
  }
  async chat(messages: ChatMessage[], options?: InferenceOptions): Promise<InferenceResponse> {
    const systemCount = messages.filter((m) => m.role === "system").length;
    if (!messages.some((m) => m.role === "user")) {
      this.calls.push({ messages, options });
      throw new Error("Inference error (openai): 400: contents is not specified");
    }
    if (systemCount > 1 || messages[0].role !== "system") {
      this.calls.push({ messages, options });
      throw new Error("Inference error (openai): 400: system message must come first, once");
    }
    if (this.failFirst > 0) {
      this.failFirst--;
      this.calls.push({ messages, options });
      throw new Error("Inference error (openai): 503: overloaded");
    }
    return super.chat(messages, options);
  }
}

function turn(partial: Partial<AgentTurn>): AgentTurn {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    state: "running",
    thinking: "",
    toolCalls: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costCents: 0,
    ...partial,
  } as AgentTurn;
}

describe("context shape", () => {
  it("keeps tool-call-only turns (empty thinking) in history with their results", () => {
    const msgs = buildContextMessages("SYS", [
      turn({
        input: "wake",
        inputSource: "wakeup" as any,
        toolCalls: [{ id: "c1", name: "get_portfolio", arguments: {}, result: "equity 100000", durationMs: 1 } as any],
      }),
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(msgs[2].tool_calls?.[0].function.name).toBe("get_portfolio");
    expect(msgs[3].tool_call_id).toBe("c1");
  });

  it("normalize: merges system messages, never sends system-only", () => {
    const out = normalizeMessagesForInference([
      { role: "system", content: "A" },
      { role: "system", content: "MEMORY" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user"]);
    expect(out[0].content).toBe("A\n\nMEMORY");
  });

  it("normalize: history starting with an assistant turn gets a user message first; trailing reply gets a nudge", () => {
    const out = normalizeMessagesForInference([
      { role: "system", content: "A" },
      { role: "assistant", content: "thinking" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("normalize: a normal conversation is unchanged", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "A" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", content: "r", tool_call_id: "x" },
    ];
    expect(normalizeMessagesForInference(msgs)).toEqual(msgs);
  });
});

describe("agent loop request shape (Gemini rules)", () => {
  let db: AutomatonDatabase;
  const trading = resolveTradingConfig({ enabled: true, enforceMarketHours: false });
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  async function run(inference: MockInferenceClient) {
    await runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig({ trading }),
      db,
      conway: new MockConwayClient(),
      inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules(undefined, trading)),
    });
  }

  it("a failed turn is retried with the same wakeup input, not with system messages only", async () => {
    const inference = new GeminiLikeInference([noToolResponse("Done.")], 1);
    await run(inference);
    expect(inference.calls.length).toBe(2);
    for (const call of inference.calls) {
      expect(call.messages.some((m) => m.role === "user")).toBe(true);
    }
    expect(inference.calls[1].messages.map((m) => m.content)).toEqual(inference.calls[0].messages.map((m) => m.content));
  });

  it("daily quota exhausted: sleeps an hour after one attempt instead of burning retries", async () => {
    class QuotaGone extends MockInferenceClient {
      async chat(messages: ChatMessage[], options?: InferenceOptions): Promise<InferenceResponse> {
        this.calls.push({ messages, options });
        throw new Error('Inference error (openai): 429: {"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}');
      }
    }
    const inference = new QuotaGone();
    const started = Date.now();
    await run(inference);
    expect(inference.calls.length).toBe(1);
    const sleepUntil = new Date(db.getKV("sleep_until") ?? 0).getTime();
    expect(sleepUntil - started).toBeGreaterThan(55 * 60_000);
  });

  it("every request across several tool-only turns has exactly one leading system message and a user message", async () => {
    const inference = new GeminiLikeInference([
      toolCallResponse([{ name: "get_portfolio", arguments: {} }]),
      toolCallResponse([{ name: "get_quote", arguments: { symbol: "RELIANCE" } }]),
      noToolResponse("Done."),
    ]);
    await run(inference);
    expect(inference.calls.length).toBe(3);
    for (const call of inference.calls) {
      const roles = call.messages.map((m) => m.role);
      expect(roles[0]).toBe("system");
      expect(roles.filter((r) => r === "system").length).toBe(1);
      expect(roles).toContain("user");
    }
    // The 3rd request carries both earlier tool calls and their results.
    const third = inference.calls[2].messages;
    expect(third.filter((m) => m.role === "tool").length).toBe(2);
  });
});
