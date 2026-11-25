/**
 * Trading mode through the real agent loop (mock inference / Conway).
 */

import crypto from "crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { runAgentLoop } from "../../agent/loop.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { ensurePaperSchema, setLedgerSealKey, trustCurrentLedgerState } from "../../trading/ledger.js";
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

beforeAll(() => setLedgerSealKey(crypto.randomBytes(32)));
afterAll(() => setLedgerSealKey(null));

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

  it("offers trading + research tools, hides money movement, and injects the trading context", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo research" } },
        { name: "exec", arguments: { command: "sqlite3 ~/.automaton/state.db .dump" } },
      ]),
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
      // Same wiring as src/index.ts
      policyEngine: new PolicyEngine(db.raw, createDefaultRules(undefined, trading)),
      spendTracker: new SpendTracker(db.raw),
      onTurnComplete: (t) => turns.push(t),
    });

    const first = inference.calls[0];
    const toolNames = (first.options?.tools ?? []).map((t: any) => t.function.name);
    expect(toolNames).toContain("place_order");
    expect(toolNames).toContain("get_portfolio");
    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("create_sandbox");
    expect(toolNames).not.toContain("transfer_credits");
    expect(toolNames).not.toContain("spawn_child");

    const system = first.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("<trading_mode>");
    expect(system).toContain("Paper equity: INR 100000.00");
    expect(system).toContain("Survival tier: high");

    const execCalls = turns.flatMap((t) => t.toolCalls).filter((tc) => tc.name === "exec");
    expect(execCalls[0].error).toBeUndefined();
    expect(execCalls[1].error).toContain("TRADING_EXEC_FORBIDDEN");
    expect(conway.execCalls.map((c) => c.command)).toEqual(["echo research"]);
  });

  it("stops as dead when paper equity is blown, without calling the model", async () => {
    ensurePaperSchema(db.raw, trading);
    db.raw.prepare("UPDATE paper_account SET cash = 5000 WHERE id = 1").run(); // 5% of start
    trustCurrentLedgerState(db.raw);
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
    trustCurrentLedgerState(db.raw);
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

  it("dies when the ledger is edited outside the runtime", async () => {
    ensurePaperSchema(db.raw, trading);
    db.raw.prepare("UPDATE paper_account SET cash = 10000000 WHERE id = 1").run(); // no reseal: tampering
    const inference = new MockInferenceClient([noToolResponse("rich!")]);

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
});
