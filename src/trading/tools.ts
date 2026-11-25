/**
 * Trading Tools
 *
 * The agent-facing tools for paper trading. Orders fill at the live market
 * price (plus slippage and fees) against the paper ledger.
 */

import type { AutomatonTool, ToolContext } from "../types.js";
import {
  applyFill,
  enforceMarginCall,
  ensurePaperSchema,
  getFills,
  getPosition,
  getSnapshot,
  recordQuote,
} from "./ledger.js";
import { getPriceProvider, isMarketOpen, normalizeSymbol } from "./market-data.js";
import { checkOrderRisk } from "./risk.js";
import {
  resolveTradingConfig,
  type AccountSnapshot,
  type Fill,
  type OrderSide,
  type TradingConfig,
} from "./types.js";

export const SYMBOL_RE = /^[A-Z0-9&^-]{1,20}$/;

function cfgOf(ctx: ToolContext): TradingConfig {
  return resolveTradingConfig(ctx.config.trading);
}

function money(n: number, cfg: TradingConfig): string {
  return `${cfg.currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatSnapshot(s: AccountSnapshot, cfg: TradingConfig): string {
  const lines = [
    ...(s.tampered ? ["LEDGER TAMPERED: the paper ledger was changed outside the runtime. The account is dead."] : []),
    `Equity: ${money(s.equity, cfg)} (start ${money(s.startingCapital, cfg)}, ${((s.equity / s.startingCapital - 1) * 100).toFixed(2)}% total)`,
    `Cash: ${money(s.cash, cfg)}${s.cash < 0 ? " (negative = margin borrowed)" : ""}`,
    `Gross exposure: ${money(s.grossExposure, cfg)} | Leverage: ${Number.isFinite(s.leverage) ? s.leverage.toFixed(2) : "∞"}x (max ${cfg.maxLeverage}x)`,
    `Buying power (equity × max leverage): ${money(Math.max(0, s.equity) * cfg.maxLeverage, cfg)}`,
    `Today P&L: ${money(s.dayPnl, cfg)} | Realized P&L (net of fees): ${money(s.realizedPnl, cfg)}`,
    `Margin call below: equity < ${cfg.maintenanceMarginPct}% of gross exposure (${money((cfg.maintenanceMarginPct / 100) * s.grossExposure, cfg)})`,
  ];
  if (s.positions.length === 0) {
    lines.push("Positions: none");
  } else {
    lines.push(`Positions (${s.positions.length}/${cfg.maxOpenPositions}):`);
    for (const p of s.positions) {
      const upnl = (p.lastPrice - p.avgPrice) * p.quantity;
      lines.push(
        `  ${p.symbol}: ${p.quantity > 0 ? "LONG" : "SHORT"} ${Math.abs(p.quantity)} @ avg ${p.avgPrice.toFixed(2)} | last ${p.lastPrice.toFixed(2)} (${p.lastPriceAt}) | unrealized ${money(upnl, cfg)}`,
      );
    }
  }
  return lines.join("\n");
}

function formatFill(f: Fill, cfg: TradingConfig): string {
  return `${f.time} ${f.reason === "margin_call" ? "[MARGIN CALL] " : ""}${f.side.toUpperCase()} ${f.quantity} ${f.symbol} @ ${f.price.toFixed(2)} | fee ${money(f.fee, cfg)} | realized ${money(f.realizedPnl, cfg)}`;
}

/**
 * Re-mark every open position at live prices, then apply a margin call if
 * maintenance margin is breached. Used each agent turn and by get_portfolio.
 */
export async function refreshPaperAccount(
  db: ToolContext["db"]["raw"],
  cfg: TradingConfig,
): Promise<{ snapshot: AccountSnapshot; liquidations: Fill[]; quoteErrors: string[] }> {
  ensurePaperSchema(db, cfg);
  const provider = getPriceProvider();
  const quoteErrors: string[] = [];
  for (const p of getSnapshot(db, cfg).positions) {
    try {
      recordQuote(db, await provider.getQuote(p.symbol, cfg.market));
    } catch (err: any) {
      quoteErrors.push(`${p.symbol}: ${err?.message ?? String(err)}`);
    }
  }
  const liquidations = enforceMarginCall(db, cfg);
  return { snapshot: getSnapshot(db, cfg), liquidations, quoteErrors };
}

function parseOrderArgs(args: Record<string, unknown>): { symbol: string; side: OrderSide; quantity: number } | string {
  const rawSymbol = typeof args.symbol === "string" ? args.symbol : "";
  const symbol = normalizeSymbol(rawSymbol);
  if (!SYMBOL_RE.test(symbol)) return `Invalid symbol: "${rawSymbol}"`;
  const side = args.side;
  if (side !== "buy" && side !== "sell") return `side must be "buy" or "sell"`;
  const quantity = Number(args.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 10_000_000) {
    return "quantity must be a positive whole number of shares";
  }
  return { symbol, side, quantity };
}

async function executeMarketOrder(
  ctx: ToolContext,
  order: { symbol: string; side: OrderSide; quantity: number },
): Promise<string> {
  const cfg = cfgOf(ctx);
  const db = ctx.db.raw;
  ensurePaperSchema(db, cfg);

  if (cfg.enforceMarketHours && !isMarketOpen(cfg.market)) {
    return `Blocked: ${cfg.market} market is closed. Orders fill only during regular hours.`;
  }

  // Live price, then re-check risk at the actual fill price.
  const quote = await getPriceProvider().getQuote(order.symbol, cfg.market);
  recordQuote(db, quote);
  const pre = enforceMarginCall(db, cfg);
  if (pre.length > 0) {
    return `Blocked: margin call executed before your order.\n${pre.map((f) => formatFill(f, cfg)).join("\n")}\n\n${formatSnapshot(getSnapshot(db, cfg), cfg)}`;
  }

  const violation = checkOrderRisk(getSnapshot(db, cfg), order, quote.price, cfg);
  if (violation) return `Blocked: ${violation.code} — ${violation.message}`;

  const fill = applyFill(db, cfg, {
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    refPrice: quote.price,
  });
  const post = enforceMarginCall(db, cfg);
  const out = [`FILLED: ${formatFill(fill, cfg)}`];
  if (post.length > 0) out.push("MARGIN CALL after fill:", ...post.map((f) => formatFill(f, cfg)));
  out.push("", formatSnapshot(getSnapshot(db, cfg), cfg));
  return out.join("\n");
}

export function createTradingTools(): AutomatonTool[] {
  return [
    {
      name: "get_quote",
      description:
        "Get the latest market price for a stock. Required before place_order (the pre-trade risk check uses this quote).",
      category: "trading",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Ticker, e.g. RELIANCE (NSE) or AAPL (US)" },
        },
        required: ["symbol"],
      },
      execute: async (args, ctx) => {
        const cfg = cfgOf(ctx);
        ensurePaperSchema(ctx.db.raw, cfg);
        const symbol = normalizeSymbol(String(args.symbol ?? ""));
        if (!SYMBOL_RE.test(symbol)) return `Invalid symbol: "${args.symbol}"`;
        const q = await getPriceProvider().getQuote(symbol, cfg.market);
        recordQuote(ctx.db.raw, q);
        return `${q.symbol}: ${q.price} ${q.currency ?? cfg.currency} (as of ${q.asOf}) | market ${isMarketOpen(cfg.market) ? "OPEN" : "CLOSED"}`;
      },
    },
    {
      name: "get_candles",
      description:
        "Get OHLCV price history for a stock. interval: 1m,5m,15m,30m,60m,1d,1wk. range: 1d,5d,1mo,3mo,6mo,1y,2y,5y.",
      category: "trading",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          interval: { type: "string", description: "Default 1d" },
          range: { type: "string", description: "Default 3mo" },
          limit: { type: "number", description: "Return only the last N candles (default 60, max 300)" },
        },
        required: ["symbol"],
      },
      execute: async (args, ctx) => {
        const cfg = cfgOf(ctx);
        const symbol = normalizeSymbol(String(args.symbol ?? ""));
        if (!SYMBOL_RE.test(symbol)) return `Invalid symbol: "${args.symbol}"`;
        const interval = typeof args.interval === "string" ? args.interval : "1d";
        const range = typeof args.range === "string" ? args.range : "3mo";
        const limit = Math.max(1, Math.min(300, Number(args.limit) || 60));
        const candles = (await getPriceProvider().getCandles(symbol, cfg.market, interval, range)).slice(-limit);
        if (candles.length === 0) return `No candles for ${symbol}.`;
        const rows = candles.map(
          (c) => `${c.time},${c.open.toFixed(2)},${c.high.toFixed(2)},${c.low.toFixed(2)},${c.close.toFixed(2)},${c.volume}`,
        );
        return `${symbol} ${interval} candles (${candles.length}):\ntime,open,high,low,close,volume\n${rows.join("\n")}`;
      },
    },
    {
      name: "place_order",
      description:
        "Place a MARKET order in the paper account. Fills at the live price plus slippage and fees. " +
        "Leverage is allowed up to the account maximum; sell more than you hold to go short. " +
        "Call get_quote for the symbol first.",
      category: "trading",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["buy", "sell"] },
          quantity: { type: "number", description: "Whole number of shares" },
          reason: { type: "string", description: "Why you are taking this trade (logged in your journal)" },
        },
        required: ["symbol", "side", "quantity"],
      },
      execute: async (args, ctx) => {
        const parsed = parseOrderArgs(args);
        if (typeof parsed === "string") return `Blocked: ${parsed}`;
        return executeMarketOrder(ctx, parsed);
      },
    },
    {
      name: "close_position",
      description: "Close the whole position in a symbol at market (sells a long, buys back a short). Always allowed by risk limits.",
      category: "trading",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
      execute: async (args, ctx) => {
        const cfg = cfgOf(ctx);
        ensurePaperSchema(ctx.db.raw, cfg);
        const symbol = normalizeSymbol(String(args.symbol ?? ""));
        const pos = getPosition(ctx.db.raw, symbol);
        if (!pos) return `No open position in ${symbol}.`;
        return executeMarketOrder(ctx, {
          symbol,
          side: pos.quantity > 0 ? "sell" : "buy",
          quantity: Math.abs(pos.quantity),
        });
      },
    },
    {
      name: "get_portfolio",
      description: "Show paper account equity, cash, leverage, positions and P&L at live prices. Your survival depends on equity.",
      category: "trading",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const cfg = cfgOf(ctx);
        const { snapshot, liquidations, quoteErrors } = await refreshPaperAccount(ctx.db.raw, cfg);
        const out: string[] = [];
        if (liquidations.length > 0) {
          out.push("MARGIN CALL — positions were force-closed:", ...liquidations.map((f) => formatFill(f, cfg)), "");
        }
        out.push(formatSnapshot(snapshot, cfg));
        out.push(`Market ${cfg.market}: ${isMarketOpen(cfg.market) ? "OPEN" : "CLOSED"}`);
        if (quoteErrors.length > 0) out.push(`Price refresh failed for: ${quoteErrors.join("; ")}`);
        return out.join("\n");
      },
    },
    {
      name: "get_trade_history",
      description: "List recent fills (newest first), including any margin-call liquidations.",
      category: "trading",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Default 20, max 500" } },
      },
      execute: async (args, ctx) => {
        const cfg = cfgOf(ctx);
        ensurePaperSchema(ctx.db.raw, cfg);
        const fills = getFills(ctx.db.raw, Number(args.limit) || 20);
        if (fills.length === 0) return "No trades yet.";
        return fills.map((f) => formatFill(f, cfg)).join("\n");
      },
    },
  ];
}
