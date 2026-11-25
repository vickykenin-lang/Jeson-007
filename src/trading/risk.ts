/**
 * Pre-trade risk checks and paper survival tiers.
 *
 * Pure functions: used by the policy rules (with the cached quote) and
 * re-checked inside place_order (with the live fill price), so a stale
 * quote can never sneak an over-leveraged order through.
 */

import type { SurvivalTier } from "../types.js";
import type { AccountSnapshot, OrderSide, TradingConfig } from "./types.js";

export interface RiskViolation {
  code: string;
  message: string;
}

export interface ProposedOrder {
  symbol: string;
  side: OrderSide;
  quantity: number;
}

const EPS = 1e-9;

/** True if the order only shrinks an existing position (no flip, no new risk). */
export function isReduceOnly(snapshot: AccountSnapshot, order: ProposedOrder): boolean {
  const p = snapshot.positions.find((x) => x.symbol === order.symbol)?.quantity ?? 0;
  if (Math.abs(p) < EPS) return false;
  const signed = order.side === "buy" ? order.quantity : -order.quantity;
  const next = p + signed;
  return Math.abs(next) < Math.abs(p) + EPS && (Math.abs(next) < EPS || Math.sign(next) === Math.sign(p));
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * Check a proposed order against leverage and risk limits.
 * Reduce-only orders always pass (closing risk is never blocked).
 */
export function checkOrderRisk(
  snapshot: AccountSnapshot,
  order: ProposedOrder,
  price: number,
  cfg: TradingConfig,
): RiskViolation | null {
  if (isReduceOnly(snapshot, order)) return null;

  const { equity } = snapshot;
  if (equity <= EPS) {
    return { code: "ACCOUNT_BLOWN", message: `Equity is ${fmt(equity)}; no new positions can be opened.` };
  }

  const existing = snapshot.positions.find((x) => x.symbol === order.symbol);
  const p = existing?.quantity ?? 0;
  const signed = order.side === "buy" ? order.quantity : -order.quantity;
  const next = p + signed;

  if (!cfg.allowShort && next < -EPS) {
    return { code: "SHORT_NOT_ALLOWED", message: "Short selling is disabled in this account." };
  }

  const lossFloor = snapshot.dayStartEquity * (1 - cfg.dailyLossLimitPct / 100);
  if (equity <= lossFloor) {
    return {
      code: "DAILY_LOSS_LIMIT",
      message:
        `Daily loss limit hit: equity ${fmt(equity)} ≤ ${fmt(lossFloor)} ` +
        `(${cfg.dailyLossLimitPct}% below today's start ${fmt(snapshot.dayStartEquity)}). ` +
        `Only reducing/closing orders are allowed until the next trading day.`,
    };
  }

  if (Math.abs(p) < EPS && snapshot.positions.length >= cfg.maxOpenPositions) {
    return {
      code: "MAX_OPEN_POSITIONS",
      message: `Already holding ${snapshot.positions.length} positions (max ${cfg.maxOpenPositions}). Close one first.`,
    };
  }

  const buyingPower = equity * cfg.maxLeverage;

  // Single-symbol concentration
  const maxSymbolNotional = buyingPower * (cfg.maxSinglePositionPct / 100);
  const nextNotional = Math.abs(next) * price;
  if (nextNotional > maxSymbolNotional + EPS) {
    const maxQty = Math.max(0, Math.floor(maxSymbolNotional / price) - Math.abs(p));
    return {
      code: "MAX_POSITION_SIZE",
      message:
        `${order.symbol} position would be ${fmt(nextNotional)}, above ${cfg.maxSinglePositionPct}% of buying power ` +
        `(${fmt(maxSymbolNotional)}). Max additional quantity now: ${maxQty}.`,
    };
  }

  // Leverage after the order (other positions at last marks, this symbol at `price`)
  const otherGross = snapshot.grossExposure - (existing ? Math.abs(existing.quantity) * existing.lastPrice : 0);
  const nextGross = otherGross + nextNotional;
  const estFee = order.quantity * price * (cfg.feeBps / 10_000);
  const nextEquity = equity - estFee;
  const nextLeverage = nextGross / nextEquity;
  if (nextLeverage > cfg.maxLeverage + EPS) {
    const room = Math.max(0, cfg.maxLeverage * nextEquity - otherGross);
    const maxQty = Math.max(0, Math.floor(room / price) - Math.abs(p));
    return {
      code: "MAX_LEVERAGE",
      message:
        `Order would take leverage to ${nextLeverage.toFixed(2)}x (max ${cfg.maxLeverage}x). ` +
        `Max quantity in this direction now: ${maxQty}.`,
    };
  }

  return null;
}

/**
 * Survival tier from paper equity as a share of starting capital.
 * ≥100% high · ≥normal% normal · ≥lowCompute% low_compute · >critical% critical · else dead.
 */
export function getTradingSurvivalTier(
  equity: number,
  startingCapital: number,
  cfg: TradingConfig,
): SurvivalTier {
  if (!(startingCapital > 0)) return "dead";
  const pct = (equity / startingCapital) * 100;
  const t = cfg.tierThresholdsPct;
  if (pct >= 100) return "high";
  if (pct >= t.normal) return "normal";
  if (pct >= t.lowCompute) return "low_compute";
  if (pct > t.critical) return "critical";
  return "dead";
}
