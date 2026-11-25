/**
 * Live dashboard: state builder and HTTP server.
 */

import crypto from "crypto";
import type { AddressInfo } from "net";
import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { buildDashboardState } from "../../dashboard/state.js";
import { createDashboardServer } from "../../dashboard/server.js";
import { DASHBOARD_HTML } from "../../dashboard/page.js";
import {
  applyFill,
  ensurePaperSchema,
  getSnapshot,
  recordEquitySample,
  recordQuote,
  setLedgerSealKey,
} from "../../trading/ledger.js";
import { resolveTradingConfig } from "../../trading/types.js";
import type { AutomatonDatabase } from "../../types.js";
import { createTestDb } from "../mocks.js";

beforeAll(() => setLedgerSealKey(crypto.randomBytes(32)));
afterAll(() => setLedgerSealKey(null));

const cfg = resolveTradingConfig({ enabled: true, feeBps: 0, slippageBps: 0, enforceMarketHours: false });

function seed(db: AutomatonDatabase): void {
  ensurePaperSchema(db.raw, cfg);
  applyFill(db.raw, cfg, { symbol: "TCS", side: "buy", quantity: 10, refPrice: 100 });
  applyFill(db.raw, cfg, { symbol: "SBIN", side: "sell", quantity: 5, refPrice: 200 });
  recordQuote(db.raw, { symbol: "TCS", price: 110, asOf: new Date().toISOString() });
  recordEquitySample(db.raw, 100_100, 0.02, 0);
  db.raw
    .prepare("INSERT INTO turns (id, timestamp, state, thinking, tool_calls) VALUES ('t1', ?, 'running', ?, ?)")
    .run(
      new Date().toISOString(),
      "<img src=x onerror=alert(1)> buying TCS",
      JSON.stringify([{ name: "place_order", arguments: { symbol: "TCS" }, result: "FILLED", durationMs: 1 }]),
    );
  db.raw
    .prepare("INSERT INTO policy_decisions (id, tool_name, tool_args_hash, risk_level, decision, reason) VALUES ('d1','exec','h','caution','deny','TRADING_EXEC_FORBIDDEN: no')")
    .run();
  db.setKV("agent_state", "running");
}

describe("dashboard state", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
    seed(db);
  });
  afterEach(() => db.close());

  it("reports account, positions, trades, activity and denials from a read-only connection", () => {
    const ro = new Database(db.raw.name, { readonly: true });
    const s = buildDashboardState(ro, { name: "bot", model: "m", trading: cfg });
    ro.close();

    expect(s.agent.state).toBe("running");
    expect(s.account?.seal).toBe("ok");
    expect(s.account?.equity).toBeCloseTo(100_100, 6); // +100 on TCS, SBIN flat at last fill
    expect(s.account?.tier).toBe("high");
    expect(s.positions.map((p) => p.symbol)).toEqual(["SBIN", "TCS"]);
    expect(s.positions.find((p) => p.symbol === "TCS")?.unrealizedPnl).toBeCloseTo(100, 6);
    expect(s.fills).toHaveLength(2);
    expect(s.equityHistory).toHaveLength(1);
    expect(s.activity[0].tools[0]).toMatchObject({ name: "place_order", ok: true });
    expect(s.denials[0]).toMatchObject({ tool: "exec" });
  });

  it("watching does not disturb the ledger seal", () => {
    const ro = new Database(db.raw.name, { readonly: true });
    for (let i = 0; i < 3; i++) buildDashboardState(ro, { name: "bot", model: "m", trading: cfg });
    ro.close();
    expect(getSnapshot(db.raw, cfg).tampered).toBe(false);
  });

  it("shows a broken seal when the ledger was edited", () => {
    db.raw.prepare("UPDATE paper_account SET cash = 1e9").run();
    const ro = new Database(db.raw.name, { readonly: true });
    const s = buildDashboardState(ro, { name: "bot", model: "m", trading: cfg });
    ro.close();
    expect(s.account?.seal).toBe("tampered");
    expect(s.account?.tier).toBe("dead");
  });

  it("handles a DB with no paper account yet", () => {
    const empty = createTestDb();
    const s = buildDashboardState(empty.raw, { name: "bot", model: "m", trading: cfg });
    expect(s.account).toBeNull();
    expect(s.positions).toEqual([]);
    empty.close();
  });
});

describe("dashboard server", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
    seed(db);
  });
  afterEach(() => db.close());

  async function start(token?: string) {
    const server = createDashboardServer({ port: 0, host: "127.0.0.1", token, dbPath: db.raw.name });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, base };
  }

  it("serves the page and JSON state", async () => {
    const { server, base } = await start();
    try {
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await page.text()).toContain("What it is doing");
      const state = await (await fetch(`${base}/api/state`)).json();
      expect(state.account.seal).toBe("ok");
      expect(state.positions).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it("requires the token when one is set", async () => {
    const { server, base } = await start("s3cret");
    try {
      expect((await fetch(`${base}/api/state`)).status).toBe(401);
      expect((await fetch(`${base}/api/state?token=wrong`)).status).toBe(401);
      expect((await fetch(`${base}/api/state?token=s3cret`)).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("rejects writes", async () => {
    const { server, base } = await start();
    try {
      expect((await fetch(`${base}/api/state`, { method: "POST" })).status).toBe(405);
    } finally {
      server.close();
    }
  });
});

describe("dashboard page", () => {
  it("never renders agent text as HTML", () => {
    expect(DASHBOARD_HTML).not.toContain("innerHTML");
    expect(DASHBOARD_HTML).not.toMatch(/<script[^>]+src=/);
    expect(DASHBOARD_HTML).not.toMatch(/<link[^>]+href=/);
  });
});
