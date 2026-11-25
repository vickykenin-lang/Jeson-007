/**
 * Trading mode through the real agent loop (mock inference / Conway).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runAgentLoop } from "../../agent/loop.js";
import { ensurePaperSchema } from "../../trading/ledger.js";
import { resolveTradingConfig } from "../../trading/types.js";
import type { AgentTurn, AutomatonDatabase } from "../../types.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
  noToolResponse,
  toolCallResponse,
} from "../mocks.js";

describe("agent loop in trading mode", () => {
  let db: AutomatonDatabase;
  const trading = resolveTradingConfig({ enabled: true, enforceMarketHours: false });

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("offers trading tools, hides exec, and injects the trading context", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "echo hi" } }]),
      noToolResponse("Done."),
    ]);
    const conway = new MockConwayClient();
    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig({ trading }),
      db,
      conway,
      inference,
      onTurnComplete: (t) => turns.push(t),
    });

    const first = inference.calls[0];
    const toolNames = (first.options?.tools ?? []).map((t: any) => t.function.name);
    expect(toolNames).toContain("place_order");
    expect(toolNames).toContain("get_portfolio");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("transfer_credits");
    expect(toolNames).not.toContain("spawn_child");

    const system = first.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("<trading_mode>");
    expect(system).toContain("Paper equity: INR 100000.00");
    expect(system).toContain("Survival tier: high");

    const execCall = turns.flatMap((t) => t.toolCalls).find((tc) => tc.name === "exec");
    expect(execCall?.error).toContain("Unknown tool: exec");
    expect(conway.execCalls).toHaveLength(0);
  });

  it("stops as dead when paper equity is blown, without calling the model", async () => {
    ensurePaperSchema(db.raw, trading);
    db.raw.prepare("UPDATE paper_account SET cash = 5000 WHERE id = 1").run(); // 5% of start
    const inference = new MockInferenceClient([noToolResponse("should not run")]);

    await runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig({ trading }),
      db,
      conway: new MockConwayClient(),
      inference,
    });

    expect(db.getAgentState()).toBe("dead");
    expect(inference.calls).toHaveLength(0);
  });

  it("uses the cheaper-model tier when equity is in low_compute range", async () => {
    ensurePaperSchema(db.raw, trading);
    db.raw.prepare("UPDATE paper_account SET cash = 40000 WHERE id = 1").run(); // 40%
    const inference = new MockInferenceClient([noToolResponse("Resting.")]);
    const setLow = vi.spyOn(inference, "setLowComputeMode");

    await runAgentLoop({
      identity: createTestIdentity(),
      config: createTestConfig({ trading }),
      db,
      conway: new MockConwayClient(),
      inference,
    });

    expect(setLow).toHaveBeenCalledWith(true);
    const system = inference.calls[0].messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("Survival tier: low_compute");
  });
});
