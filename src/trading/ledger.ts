/**
 * Paper Ledger
 *
 * The simulated brokerage account, persisted in the automaton's SQLite DB.
 * Every function is synchronous (better-sqlite3) so policy rules can read
 * account state during their synchronous evaluate().
 *
 * Accounting model (signed quantities, margin account):
 *   equity        = cash + Σ quantity × lastPrice
 *   grossExposure = Σ |quantity| × lastPrice
 *   leverage      = grossExposure / equity
 * Buying beyond cash drives cash negative (borrowed margin); shorting adds
 * sale proceeds to cash and holds a negative quantity.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { marketDate } from "./market-data.js";
import type {
  AccountSnapshot,
  Fill,
  OrderSide,
  Position,
  Quote,
  TradingConfig,
} from "./types.js";

type DB = BetterSqlite3.Database;

const EPS = 1e-9;

export function ensurePaperSchema(db: DB, cfg: TradingConfig): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cash REAL NOT NULL,
      starting_capital REAL NOT NULL,
      realized_pnl REAL NOT NULL DEFAULT 0,
      day_date TEXT,
      day_start_equity REAL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_positions (
      symbol TEXT PRIMARY KEY,
      quantity REAL NOT NULL,
      avg_price REAL NOT NULL,
      last_price REAL NOT NULL,
      last_price_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_fills (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      fee REAL NOT NULL,
      realized_pnl REAL NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_paper_fills_time ON paper_fills(time);
    CREATE TABLE IF NOT EXISTS paper_quotes (
      symbol TEXT PRIMARY KEY,
      price REAL NOT NULL,
      as_of TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);
  const row = db.prepare("SELECT id FROM paper_account WHERE id = 1").get();
  if (!row) {
    db.prepare(
      "INSERT INTO paper_account (id, cash, starting_capital, realized_pnl, created_at) VALUES (1, ?, ?, 0, ?)",
    ).run(cfg.startingCapital, cfg.startingCapital, new Date().toISOString());
  }
}

function readPositions(db: DB): Position[] {
  const rows = db
    .prepare("SELECT symbol, quantity, avg_price, last_price, last_price_at FROM paper_positions ORDER BY symbol")
    .all() as any[];
  return rows.map((r) => ({
    symbol: r.symbol,
    quantity: r.quantity,
    avgPrice: r.avg_price,
    lastPrice: r.last_price,
    lastPriceAt: r.last_price_at,
  }));
}

function readAccount(db: DB): {
  cash: number;
  starting_capital: number;
  realized_pnl: number;
  day_date: string | null;
  day_start_equity: number | null;
} {
  const row = db.prepare("SELECT * FROM paper_account WHERE id = 1").get() as any;
  if (!row) throw new Error("Paper account not initialised");
  return row;
}

function computeTotals(cash: number, positions: Position[]) {
  let marketValue = 0;
  let grossExposure = 0;
  for (const p of positions) {
    marketValue += p.quantity * p.lastPrice;
    grossExposure += Math.abs(p.quantity) * p.lastPrice;
  }
  const equity = cash + marketValue;
  const leverage = equity > EPS ? grossExposure / equity : grossExposure > 0 ? Infinity : 0;
  return { marketValue, grossExposure, equity, leverage };
}

/**
 * Current account state at last-marked prices. Rolls the daily P&L
 * baseline when the exchange date changes.
 */
export function getSnapshot(db: DB, cfg: TradingConfig, now: Date = new Date()): AccountSnapshot {
  const acct = readAccount(db);
  const positions = readPositions(db);
  const totals = computeTotals(acct.cash, positions);

  const today = marketDate(cfg.market, now);
  let dayStart = acct.day_start_equity;
  if (acct.day_date !== today || dayStart == null) {
    dayStart = totals.equity;
    db.prepare("UPDATE paper_account SET day_date = ?, day_start_equity = ? WHERE id = 1").run(today, dayStart);
  }

  return {
    cash: acct.cash,
    positions,
    marketValue: totals.marketValue,
    equity: totals.equity,
    grossExposure: totals.grossExposure,
    leverage: totals.leverage,
    startingCapital: acct.starting_capital,
    dayStartEquity: dayStart,
    dayPnl: totals.equity - dayStart,
    realizedPnl: acct.realized_pnl,
  };
}

/** Cache a quote (used by pre-trade policy checks) and re-mark any open position. */
export function recordQuote(db: DB, quote: Quote): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO paper_quotes (symbol, price, as_of, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, as_of = excluded.as_of, fetched_at = excluded.fetched_at`,
  ).run(quote.symbol, quote.price, quote.asOf, now);
  db.prepare("UPDATE paper_positions SET last_price = ?, last_price_at = ? WHERE symbol = ?").run(
    quote.price,
    quote.asOf,
    quote.symbol,
  );
}

export function getCachedQuote(
  db: DB,
  symbol: string,
): { price: number; asOf: string; fetchedAt: string } | null {
  const row = db
    .prepare("SELECT price, as_of, fetched_at FROM paper_quotes WHERE symbol = ?")
    .get(symbol) as any;
  return row ? { price: row.price, asOf: row.as_of, fetchedAt: row.fetched_at } : null;
}

export function getPosition(db: DB, symbol: string): Position | null {
  return readPositions(db).find((p) => p.symbol === symbol) ?? null;
}

export function countFillsSince(db: DB, sinceIso: string, reason: Fill["reason"] = "agent"): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM paper_fills WHERE time >= ? AND reason = ?")
    .get(sinceIso, reason) as any;
  return row?.n ?? 0;
}

export function getFills(db: DB, limit = 50): Fill[] {
  const rows = db
    .prepare("SELECT * FROM paper_fills ORDER BY time DESC, id DESC LIMIT ?")
    .all(Math.max(1, Math.min(500, limit))) as any[];
  return rows.map((r) => ({
    id: r.id,
    time: r.time,
    symbol: r.symbol,
    side: r.side,
    quantity: r.quantity,
    price: r.price,
    fee: r.fee,
    realizedPnl: r.realized_pnl,
    reason: r.reason,
  }));
}

/** Fill price after adverse slippage. */
export function slippedPrice(refPrice: number, side: OrderSide, cfg: TradingConfig): number {
  const slip = cfg.slippageBps / 10_000;
  return side === "buy" ? refPrice * (1 + slip) : refPrice * (1 - slip);
}

/**
 * Execute a market fill against the ledger (atomic).
 * Quantity is unsigned; side decides direction.
 */
export function applyFill(
  db: DB,
  cfg: TradingConfig,
  params: {
    symbol: string;
    side: OrderSide;
    quantity: number;
    refPrice: number;
    reason?: Fill["reason"];
    time?: string;
  },
): Fill {
  const { symbol, side, quantity, refPrice } = params;
  if (!(quantity > 0) || !Number.isFinite(quantity)) throw new Error("quantity must be > 0");
  if (!(refPrice > 0) || !Number.isFinite(refPrice)) throw new Error("price must be > 0");

  const time = params.time ?? new Date().toISOString();
  const price = slippedPrice(refPrice, side, cfg);
  const notional = quantity * price;
  const fee = notional * (cfg.feeBps / 10_000);
  const signed = side === "buy" ? quantity : -quantity;

  const tx = db.transaction((): Fill => {
    const acct = readAccount(db);
    const pos = getPosition(db, symbol);
    const p = pos?.quantity ?? 0;
    const avg = pos?.avgPrice ?? 0;

    let realized = 0;
    let newQty = p + signed;
    let newAvg = avg;

    if (Math.abs(p) < EPS || Math.sign(p) === Math.sign(signed)) {
      // Opening or adding in the same direction
      newAvg = (Math.abs(p) * avg + quantity * price) / Math.abs(newQty);
    } else {
      // Reducing, closing or flipping
      const closeQty = Math.min(quantity, Math.abs(p));
      realized = closeQty * (price - avg) * Math.sign(p);
      if (Math.abs(newQty) < EPS) {
        newQty = 0;
      } else if (Math.sign(newQty) !== Math.sign(p)) {
        newAvg = price; // flipped: remainder opened at this fill
      }
    }

    const cash = acct.cash - signed * price - fee;
    db.prepare("UPDATE paper_account SET cash = ?, realized_pnl = realized_pnl + ? WHERE id = 1").run(
      cash,
      realized - fee,
    );

    if (newQty === 0) {
      db.prepare("DELETE FROM paper_positions WHERE symbol = ?").run(symbol);
    } else {
      db.prepare(
        `INSERT INTO paper_positions (symbol, quantity, avg_price, last_price, last_price_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET quantity = excluded.quantity, avg_price = excluded.avg_price,
           last_price = excluded.last_price, last_price_at = excluded.last_price_at`,
      ).run(symbol, newQty, newAvg, price, time);
    }

    const fill: Fill = {
      id: ulid(),
      time,
      symbol,
      side,
      quantity,
      price,
      fee,
      realizedPnl: realized,
      reason: params.reason ?? "agent",
    };
    db.prepare(
      "INSERT INTO paper_fills (id, time, symbol, side, quantity, price, fee, realized_pnl, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(fill.id, fill.time, fill.symbol, fill.side, fill.quantity, fill.price, fill.fee, fill.realizedPnl, fill.reason);
    return fill;
  });

  return tx();
}

/** True when equity has fallen below the maintenance margin of gross exposure. */
export function isMarginCall(snapshot: AccountSnapshot, cfg: TradingConfig): boolean {
  if (snapshot.grossExposure <= EPS) return false;
  return snapshot.equity < (cfg.maintenanceMarginPct / 100) * snapshot.grossExposure;
}

/**
 * Broker-style margin call: if maintenance margin is breached, close every
 * position at its last marked price. Returns the liquidation fills.
 */
export function enforceMarginCall(db: DB, cfg: TradingConfig): Fill[] {
  const snap = getSnapshot(db, cfg);
  if (!isMarginCall(snap, cfg)) return [];
  const fills: Fill[] = [];
  for (const p of snap.positions) {
    fills.push(
      applyFill(db, cfg, {
        symbol: p.symbol,
        side: p.quantity > 0 ? "sell" : "buy",
        quantity: Math.abs(p.quantity),
        refPrice: p.lastPrice,
        reason: "margin_call",
      }),
    );
  }
  return fills;
}
