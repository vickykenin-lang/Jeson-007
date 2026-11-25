/**
 * Trading Policy Rules (paper-trading mode only)
 *
 * Leverage is allowed up to TradingConfig.maxLeverage. These rules keep that
 * freedom inside hard limits: order validation, market hours, fresh quote,
 * leverage / concentration / open-position caps, daily loss limit, order
 * rate, and a narrow write scope for the agent's notes.
 *
 * Reduce-only orders (shrinking or closing a position) are never blocked
 * by risk limits, so the agent can always cut a losing trade.
 */

import path from "path";
import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";
import {
  countFillsSince,
  ensurePaperSchema,
  getCachedQuote,
  getSnapshot,
} from "../../trading/ledger.js";
import { isMarketOpen, normalizeSymbol } from "../../trading/market-data.js";
import { checkOrderRisk, isReduceOnly } from "../../trading/risk.js";
import { SYMBOL_RE } from "../../trading/tools.js";
import type { OrderSide, TradingConfig } from "../../trading/types.js";

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

function parseOrder(args: Record<string, unknown>): { symbol: string; side: OrderSide; quantity: number } | null {
  const symbol = normalizeSymbol(typeof args.symbol === "string" ? args.symbol : "");
  const side = args.side;
  const quantity = Number(args.quantity);
  if (!SYMBOL_RE.test(symbol)) return null;
  if (side !== "buy" && side !== "sell") return null;
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 10_000_000) return null;
  return { symbol, side, quantity };
}

function createOrderValidationRule(): PolicyRule {
  return {
    id: "trading.order_validation",
    description: "Reject malformed orders (symbol, side, whole-share quantity)",
    priority: 450,
    appliesTo: { by: "name", names: ["place_order"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      if (parseOrder(request.args)) return null;
      return deny(
        "trading.order_validation",
        "INVALID_ORDER",
        'Order needs a valid symbol, side "buy"/"sell", and a positive whole-number quantity.',
      );
    },
  };
}

function createMarketHoursRule(cfg: TradingConfig, now: () => Date): PolicyRule {
  return {
    id: "trading.market_hours",
    description: `Deny orders outside ${cfg.market} regular hours`,
    priority: 450,
    appliesTo: { by: "name", names: ["place_order", "close_position"] },
    evaluate(): PolicyRuleResult | null {
      if (!cfg.enforceMarketHours || isMarketOpen(cfg.market, now())) return null;
      return deny(
        "trading.market_hours",
        "MARKET_CLOSED",
        `${cfg.market} market is closed. Plan now; orders fill only during regular hours.`,
      );
    },
  };
}

function createFreshQuoteRule(cfg: TradingConfig, now: () => Date): PolicyRule {
  return {
    id: "trading.fresh_quote_required",
    description: `Require a quote newer than ${cfg.quoteMaxAgeSeconds}s before ordering`,
    priority: 460,
    appliesTo: { by: "name", names: ["place_order"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const order = parseOrder(request.args);
      if (!order) return null; // validation rule reports it
      const db = request.context.db.raw;
      ensurePaperSchema(db, cfg);
      const q = getCachedQuote(db, order.symbol);
      const ageSec = q ? (now().getTime() - new Date(q.fetchedAt).getTime()) / 1000 : Infinity;
      if (ageSec <= cfg.quoteMaxAgeSeconds) return null;
      return deny(
        "trading.fresh_quote_required",
        "STALE_QUOTE",
        `No quote for ${order.symbol} in the last ${cfg.quoteMaxAgeSeconds}s. Call get_quote first.`,
      );
    },
  };
}

function createRiskLimitsRule(cfg: TradingConfig): PolicyRule {
  return {
    id: "trading.risk_limits",
    description:
      `Leverage ≤ ${cfg.maxLeverage}x, one symbol ≤ ${cfg.maxSinglePositionPct}% of buying power, ` +
      `≤ ${cfg.maxOpenPositions} positions, stop new risk after -${cfg.dailyLossLimitPct}% day`,
    priority: 470,
    appliesTo: { by: "name", names: ["place_order"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const order = parseOrder(request.args);
      if (!order) return null;
      const db = request.context.db.raw;
      ensurePaperSchema(db, cfg);
      const q = getCachedQuote(db, order.symbol);
      if (!q) return null; // fresh-quote rule reports it
      const v = checkOrderRisk(getSnapshot(db, cfg), order, q.price, cfg);
      return v ? deny("trading.risk_limits", v.code, v.message) : null;
    },
  };
}

function createOrderRateRule(cfg: TradingConfig, now: () => Date): PolicyRule {
  return {
    id: "trading.order_rate",
    description: `Max ${cfg.maxOrdersPerHour} new-risk orders per rolling hour`,
    priority: 480,
    appliesTo: { by: "name", names: ["place_order"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const order = parseOrder(request.args);
      if (!order) return null;
      const db = request.context.db.raw;
      ensurePaperSchema(db, cfg);
      if (isReduceOnly(getSnapshot(db, cfg), order)) return null;
      const since = new Date(now().getTime() - 3_600_000).toISOString();
      const n = countFillsSince(db, since);
      if (n < cfg.maxOrdersPerHour) return null;
      return deny(
        "trading.order_rate",
        "ORDER_RATE_LIMIT",
        `${n} orders in the last hour (max ${cfg.maxOrdersPerHour}). Overtrading burns fees; wait.`,
      );
    },
  };
}

/** Notes only: .md / .txt files inside ~/.automaton. No code, no DB, no config. */
/** Mirrors write_file's SANDBOX_HOME ("/root") so both resolve paths identically. */
export function isAllowedTradingNotePath(filePath: string, home = "/root"): boolean {
  const expanded = filePath.startsWith("~") ? path.join(home, filePath.slice(1)) : filePath;
  const resolved = path.resolve(home, expanded);
  const root = path.join(home, ".automaton");
  if (!resolved.startsWith(root + path.sep)) return false;
  const ext = path.extname(resolved).toLowerCase();
  return ext === ".md" || ext === ".txt";
}

function createWriteScopeRule(): PolicyRule {
  return {
    id: "trading.write_scope",
    description: "In trading mode, write_file may only write .md/.txt notes under ~/.automaton",
    priority: 190,
    appliesTo: { by: "name", names: ["write_file"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const p = request.args.path;
      if (typeof p === "string" && isAllowedTradingNotePath(p)) return null;
      return deny(
        "trading.write_scope",
        "TRADING_WRITE_SCOPE",
        "Trading mode: write_file is limited to .md/.txt notes in ~/.automaton (e.g. ~/.automaton/WORKLOG.md, ~/.automaton/journal.md).",
      );
    },
  };
}

export function createTradingRules(cfg: TradingConfig, now: () => Date = () => new Date()): PolicyRule[] {
  return [
    createWriteScopeRule(),
    createOrderValidationRule(),
    createMarketHoursRule(cfg, now),
    createFreshQuoteRule(cfg, now),
    createRiskLimitsRule(cfg),
    createOrderRateRule(cfg, now),
  ];
}
