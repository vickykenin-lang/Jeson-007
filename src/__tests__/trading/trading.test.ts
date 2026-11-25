/**
 * Paper Trading Mode Tests
 *
 * Ledger accounting, leverage & risk limits, margin calls, survival tiers,
 * policy-engine integration, tool allowlist and write scope.
 */

import crypto from "crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { createTradingRules, isAllowedTradingNotePath } from "../../agent/policy-rules/trading.js";
import { isProtectedFile } from "../../self-mod/code.js";
import {
  applyFill,
  enforceMarginCall,
  ensurePaperSchema,
  getSnapshot,
  isLedgerTampered,
  recordQuote,
  setLedgerSealKey,
} from "../../trading/ledger.js";
import {
  getPriceProvider,
  isMarketOpen,
  setPriceProvider,
  toProviderSymbol,
  type PriceProvider,
} from "../../trading/market-data.js";
import { checkOrderRisk, getTradingSurvivalTier } from "../../trading/risk.js";
import { createTradingTools } from "../../trading/tools.js";
import { selectTradingModeTools, TRADING_MODE_BUILTIN_TOOLS } from "../../trading/tool-allowlist.js";
import { resolveTradingConfig, type TradingConfig } from "../../trading/types.js";
import type { AutomatonDatabase, SpendTrackerInterface, ToolContext } from "../../types.js";
import {
  createTestConfig,
  createTestDb,
  createTestIdentity,
  MockConwayClient,
  MockInferenceClient,
} from "../mocks.js";

class FakePrices implements PriceProvider {
  prices = new Map<string, number>();
  set(symbol: string, price: number) {
    this.prices.set(symbol, price);
  }
  async getQuote(symbol: string) {
    const price = this.prices.get(symbol);
    if (price === undefined) throw new Error(`no price for ${symbol}`);
    return { symbol, price, asOf: new Date().toISOString() };
  }
  async getCandles() {
    return [];
  }
}

function spendTracker(): SpendTrackerInterface {
  return {
    recordSpend: () => {},
    getHourlySpend: () => 0,
    getDailySpend: () => 0,
    getTotalSpend: () => 0,
    checkLimit: () => ({ allowed: true, currentHourlySpend: 0, currentDailySpend: 0, limitHourly: 0, limitDaily: 0 }),
    pruneOldRecords: () => 0,
  } as unknown as SpendTrackerInterface;
}

// Never touch the real ~/.automaton/ledger.key from tests.
beforeAll(() => setLedgerSealKey(crypto.randomBytes(32)));
afterAll(() => setLedgerSealKey(null));

// Zero friction makes the accounting assertions exact.
const FRICTIONLESS: Partial<TradingConfig> = {
  enabled: true,
  feeBps: 0,
  slippageBps: 0,
  enforceMarketHours: false,
};

describe("paper ledger accounting", () => {
  let db: AutomatonDatabase;
  let cfg: TradingConfig;

  beforeEach(() => {
    db = createTestDb();
    cfg = resolveTradingConfig(FRICTIONLESS);
    ensurePaperSchema(db.raw, cfg);
  });
  afterEach(() => db.close());

  it("starts with cash = starting capital and no positions", () => {
    const s = getSnapshot(db.raw, cfg);
    expect(s.cash).toBe(100_000);
    expect(s.equity).toBe(100_000);
    expect(s.positions).toHaveLength(0);
    expect(s.leverage).toBe(0);
  });

  it("long, add, partial close: weighted average and realized P&L", () => {
    applyFill(db.raw, cfg, { symbol: "TCS", side: "buy", quantity: 10, refPrice: 100 });
    applyFill(db.raw, cfg, { symbol: "TCS", side: "buy", quantity: 10, refPrice: 200 });
    let s = getSnapshot(db.raw, cfg);
    expect(s.positions[0].quantity).toBe(20);
    expect(s.positions[0].avgPrice).toBe(150);

    const f = applyFill(db.raw, cfg, { symbol: "TCS", side: "sell", quantity: 5, refPrice: 250 });
    expect(f.realizedPnl).toBe(500); // 5 × (250 − 150)
    s = getSnapshot(db.raw, cfg);
    expect(s.positions[0].quantity).toBe(15);
    expect(s.positions[0].avgPrice).toBe(150);
    // equity = start + realized + unrealized at last mark (250)
    expect(s.equity).toBeCloseTo(100_000 + 500 + 15 * 100, 6);
  });

  it("buying beyond cash uses margin (negative cash) and shows leverage", () => {
    applyFill(db.raw, cfg, { symbol: "INFY", side: "buy", quantity: 300, refPrice: 1000 });
    const s = getSnapshot(db.raw, cfg);
    expect(s.cash).toBe(-200_000);
    expect(s.equity).toBe(100_000);
    expect(s.leverage).toBe(3);
  });

  it("short sale profits when price falls; flip opens at fill price", () => {
    applyFill(db.raw, cfg, { symbol: "SBIN", side: "sell", quantity: 100, refPrice: 500 });
    recordQuote(db.raw, { symbol: "SBIN", price: 450, asOf: new Date().toISOString() });
    expect(getSnapshot(db.raw, cfg).equity).toBe(105_000);

    const f = applyFill(db.raw, cfg, { symbol: "SBIN", side: "buy", quantity: 150, refPrice: 450 });
    expect(f.realizedPnl).toBe(5_000);
    const pos = getSnapshot(db.raw, cfg).positions[0];
    expect(pos.quantity).toBe(50);
    expect(pos.avgPrice).toBe(450);
  });

  it("applies slippage and fees against the trader", () => {
    const c = resolveTradingConfig({ ...FRICTIONLESS, feeBps: 10, slippageBps: 10 });
    const f = applyFill(db.raw, c, { symbol: "ITC", side: "buy", quantity: 100, refPrice: 100 });
    expect(f.price).toBeCloseTo(100.1, 9);
    expect(f.fee).toBeCloseTo(100 * 100.1 * 0.001, 9);
    expect(getSnapshot(db.raw, c).equity).toBeLessThan(100_000);
  });
});

describe("leverage and risk limits", () => {
  let db: AutomatonDatabase;
  let cfg: TradingConfig;

  beforeEach(() => {
    db = createTestDb();
    cfg = resolveTradingConfig(FRICTIONLESS); // maxLeverage 5, single position 50% of buying power
    ensurePaperSchema(db.raw, cfg);
  });
  afterEach(() => db.close());

  it("allows leverage up to the 5x maximum across positions", () => {
    // 2.5x in each of two symbols = 5x total
    expect(checkOrderRisk(getSnapshot(db.raw, cfg), { symbol: "A", side: "buy", quantity: 250 }, 1000, cfg)).toBeNull();
    applyFill(db.raw, cfg, { symbol: "A", side: "buy", quantity: 250, refPrice: 1000 });
    expect(checkOrderRisk(getSnapshot(db.raw, cfg), { symbol: "B", side: "buy", quantity: 250 }, 1000, cfg)).toBeNull();
    applyFill(db.raw, cfg, { symbol: "B", side: "buy", quantity: 250, refPrice: 1000 });
    expect(getSnapshot(db.raw, cfg).leverage).toBe(5);
  });

  it("denies orders that push leverage above the maximum, with max quantity hint", () => {
    applyFill(db.raw, cfg, { symbol: "A", side: "buy", quantity: 250, refPrice: 1000 });
    applyFill(db.raw, cfg, { symbol: "B", side: "buy", quantity: 200, refPrice: 1000 });
    const v = checkOrderRisk(getSnapshot(db.raw, cfg), { symbol: "C", side: "buy", quantity: 100 }, 1000, cfg);
    expect(v?.code).toBe("MAX_LEVERAGE");
    expect(v?.message).toContain("Max quantity in this direction now: 50");
  });

  it("caps a single symbol at 50% of buying power", () => {
    const v = checkOrderRisk(getSnapshot(db.raw, cfg), { symbol: "A", side: "buy", quantity: 260 }, 1000, cfg);
    expect(v?.code).toBe("MAX_POSITION_SIZE");
  });

  it("blocks shorts only when shorting is disabled", () => {
    const noShort = resolveTradingConfig({ ...FRICTIONLESS, allowShort: false });
    expect(checkOrderRisk(getSnapshot(db.raw, cfg), { symbol: "A", side: "sell", quantity: 10 }, 100, cfg)).toBeNull();
    expect(checkOrderRisk(getSnapshot(db.raw, noShort), { symbol: "A", side: "sell", quantity: 10 }, 100, noShort)?.code)
      .toBe("SHORT_NOT_ALLOWED");
  });

  it("daily loss limit blocks new risk but still allows closing", () => {
    applyFill(db.raw, cfg, { symbol: "A", side: "buy", quantity: 200, refPrice: 1000 });
    getSnapshot(db.raw, cfg); // fixes today's baseline at 100k
    recordQuote(db.raw, { symbol: "A", price: 920, asOf: new Date().toISOString() }); // −16,000 = −16%
    const s = getSnapshot(db.raw, cfg);
    expect(s.dayPnl).toBe(-16_000);
    expect(checkOrderRisk(s, { symbol: "B", side: "buy", quantity: 1 }, 100, cfg)?.code).toBe("DAILY_LOSS_LIMIT");
    expect(checkOrderRisk(s, { symbol: "A", side: "sell", quantity: 200 }, 920, cfg)).toBeNull();
  });

  it("limits the number of open positions", () => {
    const c = resolveTradingConfig({ ...FRICTIONLESS, maxOpenPositions: 2 });
    applyFill(db.raw, c, { symbol: "A", side: "buy", quantity: 1, refPrice: 100 });
    applyFill(db.raw, c, { symbol: "B", side: "buy", quantity: 1, refPrice: 100 });
    expect(checkOrderRisk(getSnapshot(db.raw, c), { symbol: "C", side: "buy", quantity: 1 }, 100, c)?.code)
      .toBe("MAX_OPEN_POSITIONS");
    expect(checkOrderRisk(getSnapshot(db.raw, c), { symbol: "A", side: "buy", quantity: 1 }, 100, c)).toBeNull();
  });
});

describe("margin call", () => {
  it("force-closes everything when equity < maintenance margin of gross exposure", () => {
    const db = createTestDb();
    const cfg = resolveTradingConfig(FRICTIONLESS); // maintenance 10%
    ensurePaperSchema(db.raw, cfg);
    applyFill(db.raw, cfg, { symbol: "A", side: "buy", quantity: 250, refPrice: 1000 });
    applyFill(db.raw, cfg, { symbol: "B", side: "buy", quantity: 250, refPrice: 1000 });

    // −12% on both: equity 40k, gross 440k → 9.1% < 10% → margin call
    recordQuote(db.raw, { symbol: "A", price: 880, asOf: new Date().toISOString() });
    recordQuote(db.raw, { symbol: "B", price: 880, asOf: new Date().toISOString() });
    const fills = enforceMarginCall(db.raw, cfg);
    expect(fills).toHaveLength(2);
    expect(fills.every((f) => f.reason === "margin_call")).toBe(true);
    const s = getSnapshot(db.raw, cfg);
    expect(s.positions).toHaveLength(0);
    expect(s.equity).toBeCloseTo(40_000, 6);
    db.close();
  });

  it("does nothing while margin is healthy", () => {
    const db = createTestDb();
    const cfg = resolveTradingConfig(FRICTIONLESS);
    ensurePaperSchema(db.raw, cfg);
    applyFill(db.raw, cfg, { symbol: "A", side: "buy", quantity: 250, refPrice: 1000 });
    recordQuote(db.raw, { symbol: "A", price: 900, asOf: new Date().toISOString() });
    expect(enforceMarginCall(db.raw, cfg)).toHaveLength(0);
    db.close();
  });
});

describe("paper survival tiers", () => {
  const cfg = resolveTradingConfig({ enabled: true });
  it.each([
    [120_000, "high"],
    [100_000, "high"],
    [70_000, "normal"],
    [40_000, "low_compute"],
    [15_000, "critical"],
    [10_000, "dead"],
    [-5_000, "dead"],
  ])("equity %d → %s", (equity, tier) => {
    expect(getTradingSurvivalTier(equity, 100_000, cfg)).toBe(tier);
  });
});

describe("policy engine + trading tools", () => {
  let db: AutomatonDatabase;
  let prices: FakePrices;
  let original: PriceProvider;
  let ctx: ToolContext;
  let engine: PolicyEngine;
  const tools = createTradingTools();
  const turn = () => ({ inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: spendTracker() });

  beforeEach(() => {
    db = createTestDb();
    original = getPriceProvider();
    prices = new FakePrices();
    setPriceProvider(prices);
    const trading = resolveTradingConfig(FRICTIONLESS);
    ctx = {
      identity: createTestIdentity(),
      config: createTestConfig({ trading }),
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    };
    engine = new PolicyEngine(db.raw, createDefaultRules(undefined, trading));
  });
  afterEach(() => {
    setPriceProvider(original);
    db.close();
  });

  it("requires a fresh quote before place_order", async () => {
    prices.set("RELIANCE", 1300);
    const r = await executeTool("place_order", { symbol: "RELIANCE", side: "buy", quantity: 10 }, tools, ctx, engine, turn());
    expect(r.error).toContain("STALE_QUOTE");
  });

  it("fills a leveraged order after get_quote and reports the portfolio", async () => {
    prices.set("RELIANCE", 1000);
    await executeTool("get_quote", { symbol: "reliance" }, tools, ctx, engine, turn());
    const r = await executeTool("place_order", { symbol: "RELIANCE", side: "buy", quantity: 200 }, tools, ctx, engine, turn());
    expect(r.error).toBeUndefined();
    expect(r.result).toContain("FILLED: ");
    expect(r.result).toContain("Leverage: 2.00x");
  });

  it("denies over-leverage through the policy engine", async () => {
    prices.set("TCS", 1000);
    await executeTool("get_quote", { symbol: "TCS" }, tools, ctx, engine, turn());
    const r = await executeTool("place_order", { symbol: "TCS", side: "buy", quantity: 300 }, tools, ctx, engine, turn());
    expect(r.error).toContain("MAX_POSITION_SIZE");
  });

  it("re-checks risk at the live fill price even if the cached quote was lower", async () => {
    prices.set("TCS", 1000);
    await executeTool("get_quote", { symbol: "TCS" }, tools, ctx, engine, turn());
    prices.set("TCS", 1100); // price moved before the fill
    const r = await executeTool("place_order", { symbol: "TCS", side: "buy", quantity: 250 }, tools, ctx, engine, turn());
    expect(r.result).toContain("Blocked: MAX_POSITION_SIZE");
  });

  it("close_position always closes", async () => {
    prices.set("INFY", 1000);
    await executeTool("get_quote", { symbol: "INFY" }, tools, ctx, engine, turn());
    await executeTool("place_order", { symbol: "INFY", side: "sell", quantity: 100 }, tools, ctx, engine, turn());
    prices.set("INFY", 900);
    const r = await executeTool("close_position", { symbol: "INFY" }, tools, ctx, engine, turn());
    expect(r.result).toContain("FILLED: ");
    expect(r.result).toContain("Positions: none");
    expect(getSnapshot(db.raw, ctx.config.trading!).equity).toBeCloseTo(110_000, 6);
  });

  it("rejects malformed orders", async () => {
    const r = await executeTool("place_order", { symbol: "X; rm -rf", side: "buy", quantity: 1.5 }, tools, ctx, engine, turn());
    expect(r.error).toContain("INVALID_ORDER");
  });

  it("denies orders when the market is closed (rule)", () => {
    const cfg = resolveTradingConfig({ enabled: true, enforceMarketHours: true });
    const saturday = () => new Date("2026-11-28T06:00:00Z");
    const rule = createTradingRules(cfg, saturday).find((r) => r.id === "trading.market_hours")!;
    const res = rule.evaluate({ tool: tools[2], args: {}, context: ctx, turnContext: turn() });
    expect(res?.reasonCode).toBe("MARKET_CLOSED");
  });
});

describe("market hours", () => {
  it("NSE open on a weekday at 10:00 IST, closed at 16:00 and on Saturday", () => {
    expect(isMarketOpen("NSE", new Date("2026-11-25T04:30:00Z"))).toBe(true); // 10:00 IST Wed
    expect(isMarketOpen("NSE", new Date("2026-11-25T10:30:00Z"))).toBe(false); // 16:00 IST
    expect(isMarketOpen("NSE", new Date("2026-11-28T04:30:00Z"))).toBe(false); // Saturday
  });
  it("US open at 10:00 ET", () => {
    expect(isMarketOpen("US", new Date("2026-11-25T15:00:00Z"))).toBe(true);
    expect(isMarketOpen("US", new Date("2026-11-25T13:00:00Z"))).toBe(false);
  });
  it("NSE symbols get the .NS suffix for the data provider", () => {
    expect(toProviderSymbol("reliance", "NSE")).toBe("RELIANCE.NS");
    expect(toProviderSymbol("AAPL", "US")).toBe("AAPL");
  });
});

describe("trading-mode tool set", () => {
  const builtins = createBuiltinTools("test-sandbox");
  const selected = selectTradingModeTools(builtins, createTradingTools());
  const names = new Set(selected.map((t) => t.name));

  it("every allowlisted built-in tool exists", () => {
    const builtinNames = new Set(builtins.map((t) => t.name));
    for (const n of TRADING_MODE_BUILTIN_TOOLS) expect(builtinNames.has(n), n).toBe(true);
  });

  it("includes the trading tools", () => {
    for (const n of ["get_quote", "get_candles", "place_order", "close_position", "get_portfolio", "get_trade_history"]) {
      expect(names.has(n), n).toBe(true);
    }
  });

  it("keeps the shell and research sandboxes", () => {
    for (const n of ["exec", "create_sandbox", "list_sandboxes"]) expect(names.has(n), n).toBe(true);
  });

  it("removes money movement, self-modification and replication", () => {
    for (const n of [
      "transfer_credits", "topup_credits", "spawn_child", "fund_child", "edit_own_file",
      "install_npm_package", "install_mcp_server", "install_skill", "pull_upstream", "git_push",
      "register_domain", "expose_port", "delete_sandbox", "update_genesis_prompt", "create_goal",
      "modify_heartbeat",
    ]) {
      expect(names.has(n), n).toBe(false);
    }
  });
});

describe("trading write scope and protection", () => {
  it("allows notes under ~/.automaton only", () => {
    expect(isAllowedTradingNotePath("~/.automaton/journal.md")).toBe(true);
    expect(isAllowedTradingNotePath("/root/.automaton/WORKLOG.md")).toBe(true);
    expect(isAllowedTradingNotePath("/root/.automaton/state.db")).toBe(false);
    expect(isAllowedTradingNotePath("/root/.automaton/../x.md")).toBe(false);
    expect(isAllowedTradingNotePath("/root/automaton/src/trading/ledger.ts")).toBe(false);
  });

  it("ledger, its key and trading rules are protected files", () => {
    expect(isProtectedFile("/root/automaton/src/trading/ledger.ts")).toBe(true);
    expect(isProtectedFile("/root/automaton/dist/agent/policy-rules/trading.js")).toBe(true);
    expect(isProtectedFile("/root/.automaton/ledger.key")).toBe(true);
  });
});

describe("ledger tamper seal", () => {
  let db: AutomatonDatabase;
  const cfg = resolveTradingConfig(FRICTIONLESS);

  beforeEach(() => {
    db = createTestDb();
    ensurePaperSchema(db.raw, cfg);
  });
  afterEach(() => db.close());

  it("normal trading keeps the seal valid", () => {
    applyFill(db.raw, cfg, { symbol: "A", side: "buy", quantity: 10, refPrice: 100 });
    recordQuote(db.raw, { symbol: "A", price: 110, asOf: new Date().toISOString() });
    getSnapshot(db.raw, cfg);
    expect(isLedgerTampered(db.raw)).toBe(false);
  });

  it("a direct SQL edit of cash is detected and kills the account", () => {
    db.raw.prepare("UPDATE paper_account SET cash = 999999999 WHERE id = 1").run();
    const s = getSnapshot(db.raw, cfg);
    expect(s.tampered).toBe(true);
    expect(getTradingSurvivalTier(s.equity, s.startingCapital, cfg, s.tampered)).toBe("dead");
    expect(checkOrderRisk(s, { symbol: "A", side: "buy", quantity: 1 }, 100, cfg)?.code).toBe("LEDGER_TAMPERED");
    expect(() => applyFill(db.raw, cfg, { symbol: "A", side: "buy", quantity: 1, refPrice: 100 })).toThrow(/LEDGER_TAMPERED/);
  });

  it("the tampered flag is sticky: clearing it by SQL is detected again", () => {
    db.raw.prepare("UPDATE paper_positions SET quantity = 1").run();
    db.raw.prepare("INSERT INTO paper_fills VALUES ('x','t','A','buy',1,1,0,0,'agent')").run();
    expect(getSnapshot(db.raw, cfg).tampered).toBe(true);
    db.raw.prepare("UPDATE paper_seal SET tampered = 0").run();
    expect(getSnapshot(db.raw, cfg).tampered).toBe(true);
  });

  it("forging a quote to inflate a position is detected", () => {
    applyFill(db.raw, cfg, { symbol: "A", side: "buy", quantity: 10, refPrice: 100 });
    db.raw.prepare("UPDATE paper_positions SET last_price = 100000 WHERE symbol = 'A'").run();
    expect(getSnapshot(db.raw, cfg).tampered).toBe(true);
  });

  it("deleting the ledger tables does not reset the account", () => {
    applyFill(db.raw, cfg, { symbol: "A", side: "buy", quantity: 10, refPrice: 100 });
    db.raw.exec("DELETE FROM paper_account; DELETE FROM paper_seal; DELETE FROM paper_positions;");
    ensurePaperSchema(db.raw, cfg);
    expect(getSnapshot(db.raw, cfg).tampered).toBe(true);
  });

  it("a ledger found without its seal while a key from an earlier run exists is tampered", () => {
    const other = createTestDb();
    setLedgerSealKey(crypto.randomBytes(32), true);
    try {
      ensurePaperSchema(other.raw, cfg);
      expect(getSnapshot(other.raw, cfg).tampered).toBe(true);
    } finally {
      setLedgerSealKey(crypto.randomBytes(32));
      other.close();
    }
  });
});

describe("shell guard and sandbox limits", () => {
  let db: AutomatonDatabase;
  let ctx: ToolContext;
  let engine: PolicyEngine;
  const trading = resolveTradingConfig(FRICTIONLESS);
  const tools = selectTradingModeTools(createBuiltinTools("test-sandbox"), createTradingTools());
  const turn = () => ({ inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: spendTracker() });

  beforeEach(() => {
    db = createTestDb();
    ctx = {
      identity: createTestIdentity(),
      config: createTestConfig({ trading }),
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    };
    engine = new PolicyEngine(db.raw, createDefaultRules(undefined, trading));
  });
  afterEach(() => db.close());

  it("allows research commands", async () => {
    const conway = ctx.conway as MockConwayClient;
    for (const command of [
      "curl -s https://www.nseindia.com/api/marketStatus",
      "python3 -c 'import pandas; print(pandas.__version__)'",
      "pip install yfinance",
    ]) {
      const r = await executeTool("exec", { command }, tools, ctx, engine, turn());
      expect(r.error, command).toBeUndefined();
    }
    expect(conway.execCalls).toHaveLength(3);
  });

  it.each([
    "sqlite3 ~/.automaton/state.db 'UPDATE paper_account SET cash=1e9'",
    "python3 -c \"import sqlite3; sqlite3.connect('/root/.automaton/x')\"",
    "cat ~/.automaton/ledger.key",
    "sed -i 's/maxLeverage/x/' ~/.automaton/automaton.json",
    "cp evil.js /root/automaton/dist/trading/ledger.js",
    "head -c 100 /root/.automaton/wallet.json",
    "cat /proc/1/environ",
    "pkill -f node",
  ])("blocks: %s", async (command) => {
    const r = await executeTool("exec", { command }, tools, ctx, engine, turn());
    expect(r.error).toContain("TRADING_EXEC_FORBIDDEN");
    expect((ctx.conway as MockConwayClient).execCalls).toHaveLength(0);
  });

  it("caps sandbox size", async () => {
    const r = await executeTool("create_sandbox", { name: "big", vcpu: 8, memory_mb: 16384 }, tools, ctx, engine, turn());
    expect(r.error).toContain("SANDBOX_TOO_LARGE");
  });

  it("caps sandboxes per day", async () => {
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await executeTool("create_sandbox", { name: `r${i}` }, tools, ctx, engine, turn()));
    }
    expect(results[0].error).toBeUndefined();
    expect(results[1].error).toBeUndefined();
    expect(results[2].error).toContain("SANDBOX_DAILY_LIMIT");
  });
});
