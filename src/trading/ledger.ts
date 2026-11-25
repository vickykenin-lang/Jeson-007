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

import crypto from "crypto";
import fs from "fs";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import { getAutomatonDir } from "../identity/wallet.js";
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

// ─── Tamper seal ─────────────────────────────────────────────────
//
// The agent has a shell in trading mode, so it could try to edit the
// paper tables directly (e.g. raise its cash). Every legitimate ledger
// write re-signs the full ledger state with an HMAC; every read verifies
// it first. A mismatch sets a sticky `tampered` flag (itself covered by
// the seal), which makes the account dead. The HMAC key lives in
// ~/.automaton/ledger.key (0600), which read_file and exec may not touch.

let injectedSealKey: Buffer | null = null;
let injectedKeyPreexisted = false;
let cachedSealKey: Buffer | null = null;
let keyFilePreexisted = false;
/** DB files whose ledger this process has already seen (a later "fresh" ledger there is a deletion). */
const initializedLedgers = new Set<string>();

/**
 * Override the seal key (tests). `preexisting` simulates a key left by an
 * earlier run. Pass null to go back to the key file.
 */
export function setLedgerSealKey(key: Buffer | null, preexisting = false): void {
  injectedSealKey = key;
  injectedKeyPreexisted = preexisting;
  cachedSealKey = null;
}

export function getLedgerKeyPath(): string {
  return path.join(getAutomatonDir(), "ledger.key");
}

/** True when the seal key already existed before this process first needed it. */
function sealKeyPreexisted(): boolean {
  if (injectedSealKey) return injectedKeyPreexisted;
  getSealKey();
  return keyFilePreexisted;
}

function getSealKey(): Buffer {
  if (injectedSealKey) return injectedSealKey;
  if (cachedSealKey) return cachedSealKey;
  const keyPath = getLedgerKeyPath();
  if (fs.existsSync(keyPath)) {
    keyFilePreexisted = true;
    cachedSealKey = Buffer.from(fs.readFileSync(keyPath, "utf-8").trim(), "hex");
  } else {
    keyFilePreexisted = false;
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
    cachedSealKey = key;
  }
  if (cachedSealKey.length < 32) throw new Error("ledger.key is invalid");
  return cachedSealKey;
}

function ledgerDigest(db: DB): string {
  const acct = db.prepare("SELECT * FROM paper_account WHERE id = 1").get();
  const positions = db.prepare("SELECT * FROM paper_positions ORDER BY symbol").all();
  const fills = db.prepare("SELECT * FROM paper_fills ORDER BY id").all();
  const quotes = db.prepare("SELECT * FROM paper_quotes ORDER BY symbol").all();
  const flag = db.prepare("SELECT tampered, tampered_at FROM paper_seal WHERE id = 1").get() ?? null;
  const canonical = JSON.stringify({ acct, positions, fills, quotes, flag });
  return crypto.createHmac("sha256", getSealKey()).update(canonical).digest("hex");
}

function reseal(db: DB): void {
  const digest = ledgerDigest(db);
  db.prepare("UPDATE paper_seal SET seal = ? WHERE id = 1").run(digest);
}

/**
 * Verify the ledger seal. On mismatch, permanently flag the account as
 * tampered (and re-sign so the flag itself is protected).
 * Returns true when the account is (or already was) tampered.
 */
function verifySeal(db: DB): boolean {
  const row = db.prepare("SELECT seal, tampered FROM paper_seal WHERE id = 1").get() as
    | { seal: string; tampered: number }
    | undefined;
  if (!row) return true;
  const expected = ledgerDigest(db);
  const ok =
    row.seal.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(row.seal), Buffer.from(expected));
  if (!ok) {
    db.prepare("UPDATE paper_seal SET tampered = 1, tampered_at = ? WHERE id = 1").run(new Date().toISOString());
    reseal(db);
    return true;
  }
  return row.tampered === 1;
}

/**
 * Seal check for outside readers (the dashboard) that open the DB read-only.
 * Never writes and never creates a key file.
 */
export function verifyLedgerSealReadOnly(db: DB): "ok" | "tampered" | "no_key" | "no_ledger" {
  try {
    const row = db.prepare("SELECT seal, tampered FROM paper_seal WHERE id = 1").get() as
      | { seal: string; tampered: number }
      | undefined;
    if (!row) return "no_ledger";
    if (row.tampered === 1) return "tampered";
    if (!injectedSealKey && !cachedSealKey && !fs.existsSync(getLedgerKeyPath())) return "no_key";
    const expected = ledgerDigest(db);
    return row.seal === expected ? "ok" : "tampered";
  } catch {
    return "no_ledger";
  }
}

/** Append an equity sample for charts, at most one per `minIntervalMs`. Not part of the seal. */
export function recordEquitySample(db: DB, equity: number, leverage: number, minIntervalMs = 60_000): void {
  const last = db.prepare("SELECT time FROM paper_equity_history ORDER BY time DESC LIMIT 1").get() as
    | { time: string }
    | undefined;
  const now = new Date();
  if (last && now.getTime() - new Date(last.time).getTime() < minIntervalMs) return;
  db.prepare("INSERT OR REPLACE INTO paper_equity_history (time, equity, leverage) VALUES (?, ?, ?)").run(
    now.toISOString(),
    equity,
    Number.isFinite(leverage) ? leverage : 0,
  );
}

/** Read-only check used by status code. */
export function isLedgerTampered(db: DB): boolean {
  return db.transaction(() => verifySeal(db))();
}

/** Re-sign the current ledger state as trusted (tests and creator tooling only). */
export function trustCurrentLedgerState(db: DB): void {
  db.transaction(() => reseal(db))();
}

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
    CREATE TABLE IF NOT EXISTS paper_equity_history (
      time TEXT PRIMARY KEY,
      equity REAL NOT NULL,
      leverage REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_seal (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seal TEXT NOT NULL,
      tampered INTEGER NOT NULL DEFAULT 0,
      tampered_at TEXT
    );
  `);
  db.transaction(() => {
    const acct = db.prepare("SELECT id FROM paper_account WHERE id = 1").get();
    const seal = db.prepare("SELECT id FROM paper_seal WHERE id = 1").get();
    if (acct && seal) {
      initializedLedgers.add(db.name);
      return;
    }

    // A genuinely new ledger has neither row AND no key from an earlier run.
    // Anything else (rows deleted, seal dropped, key kept) means someone
    // removed ledger state outside the runtime: create the rows so the code
    // keeps working, but mark the account tampered. A creator reset deletes
    // the paper_* tables AND ~/.automaton/ledger.key.
    const genuineNew = !acct && !seal && !sealKeyPreexisted() && !initializedLedgers.has(db.name);
    initializedLedgers.add(db.name);
    if (!acct) {
      db.prepare(
        "INSERT INTO paper_account (id, cash, starting_capital, realized_pnl, created_at) VALUES (1, ?, ?, 0, ?)",
      ).run(cfg.startingCapital, cfg.startingCapital, new Date().toISOString());
    }
    if (!seal) {
      db.prepare("INSERT INTO paper_seal (id, seal, tampered) VALUES (1, '', 0)").run();
    }
    if (!genuineNew) {
      db.prepare("UPDATE paper_seal SET tampered = 1, tampered_at = ? WHERE id = 1").run(new Date().toISOString());
    }
    reseal(db);
  })();
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
  return db.transaction(() => snapshotInTx(db, cfg, now))();
}

function snapshotInTx(db: DB, cfg: TradingConfig, now: Date): AccountSnapshot {
  const tampered = verifySeal(db);
  const acct = readAccount(db);
  const positions = readPositions(db);
  const totals = computeTotals(acct.cash, positions);

  const today = marketDate(cfg.market, now);
  let dayStart = acct.day_start_equity;
  if (acct.day_date !== today || dayStart == null) {
    dayStart = totals.equity;
    db.prepare("UPDATE paper_account SET day_date = ?, day_start_equity = ? WHERE id = 1").run(today, dayStart);
    reseal(db);
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
    tampered,
  };
}

/** Cache a quote (used by pre-trade policy checks) and re-mark any open position. */
export function recordQuote(db: DB, quote: Quote): void {
  db.transaction(() => {
    verifySeal(db);
    recordQuoteInTx(db, quote);
    reseal(db);
  })();
}

function recordQuoteInTx(db: DB, quote: Quote): void {
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
    if (verifySeal(db)) throw new Error("LEDGER_TAMPERED: the paper ledger was modified outside the runtime; trading is disabled.");
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
    reseal(db);
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
  if (snap.tampered || !isMarginCall(snap, cfg)) return [];
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
