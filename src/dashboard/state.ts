/**
 * Dashboard state builder.
 *
 * Reads the automaton's SQLite DB (opened read-only by the server) and
 * returns one JSON snapshot for the live dashboard. It never calls ledger
 * functions that write, so watching the agent cannot disturb the ledger seal.
 */

import fs from "fs";
import type BetterSqlite3 from "better-sqlite3";
import { verifyLedgerSealReadOnly } from "../trading/ledger.js";
import { isMarketOpen } from "../trading/market-data.js";
import { getTradingSurvivalTier } from "../trading/risk.js";
import type { TradingConfig } from "../trading/types.js";

type DB = BetterSqlite3.Database;

export interface DashboardState {
  generatedAt: string;
  agent: {
    name: string;
    state: string;
    lastTurnAt: string | null;
    turnCount: number;
    model: string;
  };
  trading: {
    enabled: boolean;
    market: string;
    currency: string;
    marketOpen: boolean;
    maxLeverage: number;
    maintenanceMarginPct: number;
    dailyLossLimitPct: number;
  };
  account: null | {
    equity: number;
    cash: number;
    startingCapital: number;
    totalReturnPct: number;
    dayPnl: number;
    dayStartEquity: number | null;
    realizedPnl: number;
    grossExposure: number;
    leverage: number;
    tier: string;
    seal: "ok" | "tampered" | "no_key" | "no_ledger";
    marginCallAt: number;
  };
  positions: {
    symbol: string;
    quantity: number;
    avgPrice: number;
    lastPrice: number;
    lastPriceAt: string;
    marketValue: number;
    unrealizedPnl: number;
    unrealizedPct: number;
  }[];
  fills: {
    time: string;
    symbol: string;
    side: string;
    quantity: number;
    price: number;
    fee: number;
    realizedPnl: number;
    reason: string;
  }[];
  equityHistory: { time: string; equity: number }[];
  activity: {
    time: string;
    source: string | null;
    thinking: string;
    tools: { name: string; ok: boolean; summary: string }[];
  }[];
  denials: { time: string; tool: string; reason: string }[];
  journal: string | null;
}

function hasTable(db: DB, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function kv(db: DB, key: string): string | null {
  if (!hasTable(db, "kv")) return null;
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function readTail(filePath: string | undefined, maxChars: number): string | null {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, "utf-8");
    return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
  } catch {
    return null;
  }
}

export function buildDashboardState(
  db: DB,
  opts: {
    name: string;
    model: string;
    trading?: TradingConfig;
    journalPath?: string;
    now?: Date;
  },
): DashboardState {
  const now = opts.now ?? new Date();
  const cfg = opts.trading;

  // ── Agent ──
  const turnCount = hasTable(db, "turns")
    ? ((db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n ?? 0)
    : 0;
  const lastTurn = hasTable(db, "turns")
    ? (db.prepare("SELECT timestamp FROM turns ORDER BY timestamp DESC LIMIT 1").get() as { timestamp: string } | undefined)
    : undefined;

  // ── Account (computed from raw rows, no ledger writes) ──
  let account: DashboardState["account"] = null;
  let positions: DashboardState["positions"] = [];
  if (hasTable(db, "paper_account")) {
    const a = db.prepare("SELECT * FROM paper_account WHERE id = 1").get() as any;
    if (a) {
      const rows = db.prepare("SELECT * FROM paper_positions ORDER BY symbol").all() as any[];
      let marketValue = 0;
      let gross = 0;
      positions = rows.map((p) => {
        const mv = p.quantity * p.last_price;
        marketValue += mv;
        gross += Math.abs(mv);
        const upnl = (p.last_price - p.avg_price) * p.quantity;
        return {
          symbol: p.symbol,
          quantity: p.quantity,
          avgPrice: p.avg_price,
          lastPrice: p.last_price,
          lastPriceAt: p.last_price_at,
          marketValue: mv,
          unrealizedPnl: upnl,
          unrealizedPct: p.avg_price > 0 ? ((p.last_price - p.avg_price) / p.avg_price) * 100 * Math.sign(p.quantity) : 0,
        };
      });
      const equity = a.cash + marketValue;
      const seal = verifyLedgerSealReadOnly(db);
      account = {
        equity,
        cash: a.cash,
        startingCapital: a.starting_capital,
        totalReturnPct: a.starting_capital > 0 ? (equity / a.starting_capital - 1) * 100 : 0,
        dayPnl: a.day_start_equity == null ? 0 : equity - a.day_start_equity,
        dayStartEquity: a.day_start_equity,
        realizedPnl: a.realized_pnl,
        grossExposure: gross,
        leverage: equity > 0 ? gross / equity : gross > 0 ? Infinity : 0,
        tier: cfg ? getTradingSurvivalTier(equity, a.starting_capital, cfg, seal === "tampered") : "n/a",
        seal,
        marginCallAt: cfg ? (cfg.maintenanceMarginPct / 100) * gross : 0,
      };
    }
  }

  const fills = hasTable(db, "paper_fills")
    ? (db.prepare("SELECT * FROM paper_fills ORDER BY time DESC, id DESC LIMIT 30").all() as any[]).map((f) => ({
        time: f.time,
        symbol: f.symbol,
        side: f.side,
        quantity: f.quantity,
        price: f.price,
        fee: f.fee,
        realizedPnl: f.realized_pnl,
        reason: f.reason,
      }))
    : [];

  const equityHistory = hasTable(db, "paper_equity_history")
    ? (db
        .prepare("SELECT time, equity FROM (SELECT time, equity FROM paper_equity_history ORDER BY time DESC LIMIT 1500) ORDER BY time")
        .all() as { time: string; equity: number }[])
    : [];

  // ── Activity: recent turns with their tool calls ──
  const activity = hasTable(db, "turns")
    ? (db.prepare("SELECT timestamp, input_source, thinking, tool_calls FROM turns ORDER BY timestamp DESC LIMIT 15").all() as any[]).map(
        (t) => {
          let calls: any[] = [];
          try {
            calls = JSON.parse(t.tool_calls || "[]");
          } catch {
            calls = [];
          }
          return {
            time: t.timestamp,
            source: t.input_source ?? null,
            thinking: clip(t.thinking, 600),
            tools: calls.map((c) => ({
              name: String(c.name ?? "?"),
              ok: !c.error,
              summary: clip(
                c.error
                  ? c.error
                  : `${c.arguments ? JSON.stringify(c.arguments) : ""} → ${c.result ?? ""}`,
                220,
              ),
            })),
          };
        },
      )
    : [];

  const denials = hasTable(db, "policy_decisions")
    ? (db
        .prepare(
          "SELECT created_at, tool_name, reason FROM policy_decisions WHERE decision != 'allow' ORDER BY created_at DESC LIMIT 15",
        )
        .all() as any[]).map((d) => ({ time: d.created_at, tool: d.tool_name, reason: clip(d.reason, 240) }))
    : [];

  return {
    generatedAt: now.toISOString(),
    agent: {
      name: opts.name,
      state: kv(db, "agent_state") ?? "unknown",
      lastTurnAt: lastTurn?.timestamp ?? null,
      turnCount,
      model: opts.model,
    },
    trading: {
      enabled: Boolean(cfg?.enabled),
      market: cfg?.market ?? "-",
      currency: cfg?.currency ?? "",
      marketOpen: cfg ? isMarketOpen(cfg.market, now) : false,
      maxLeverage: cfg?.maxLeverage ?? 0,
      maintenanceMarginPct: cfg?.maintenanceMarginPct ?? 0,
      dailyLossLimitPct: cfg?.dailyLossLimitPct ?? 0,
    },
    account,
    positions,
    fills,
    equityHistory,
    activity,
    denials,
    journal: readTail(opts.journalPath, 6000),
  };
}
