/**
 * Market Data
 *
 * Real prices for the paper account. Default provider is Yahoo Finance's
 * public chart endpoint (no key needed; covers NSE via ".NS" and US tickers).
 * Tests and alternative feeds plug in through setPriceProvider().
 */

import type { Candle, Quote, TradingMarket } from "./types.js";

export interface PriceProvider {
  getQuote(symbol: string, market: TradingMarket): Promise<Quote>;
  getCandles(
    symbol: string,
    market: TradingMarket,
    interval: string,
    range: string,
  ): Promise<Candle[]>;
}

const ALLOWED_INTERVALS = new Set(["1m", "5m", "15m", "30m", "60m", "1d", "1wk"]);
const ALLOWED_RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"]);

/** Uppercase, strip spaces; NSE symbols get the ".NS" suffix for Yahoo. */
export function toProviderSymbol(symbol: string, market: TradingMarket): string {
  const s = symbol.trim().toUpperCase();
  if (market === "NSE" && !s.endsWith(".NS") && !s.startsWith("^")) return `${s}.NS`;
  return s;
}

/** Canonical symbol stored in the ledger (no provider suffix). */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.NS$/, "");
}

export class YahooPriceProvider implements PriceProvider {
  private base = "https://query1.finance.yahoo.com/v8/finance/chart/";

  private async fetchChart(
    symbol: string,
    market: TradingMarket,
    interval: string,
    range: string,
  ): Promise<any> {
    const url =
      `${this.base}${encodeURIComponent(toProviderSymbol(symbol, market))}` +
      `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (paper-trading-agent)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Market data HTTP ${res.status} for ${symbol}`);
    const body: any = await res.json();
    const result = body?.chart?.result?.[0];
    if (!result) {
      const msg = body?.chart?.error?.description || "no data";
      throw new Error(`Market data error for ${symbol}: ${msg}`);
    }
    return result;
  }

  async getQuote(symbol: string, market: TradingMarket): Promise<Quote> {
    const r = await this.fetchChart(symbol, market, "1m", "1d");
    const price = Number(r.meta?.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`No valid price for ${symbol}`);
    }
    const t = Number(r.meta?.regularMarketTime);
    return {
      symbol: normalizeSymbol(symbol),
      price,
      asOf: Number.isFinite(t) ? new Date(t * 1000).toISOString() : new Date().toISOString(),
      currency: r.meta?.currency,
    };
  }

  async getCandles(
    symbol: string,
    market: TradingMarket,
    interval: string,
    range: string,
  ): Promise<Candle[]> {
    if (!ALLOWED_INTERVALS.has(interval)) throw new Error(`Unsupported interval: ${interval}`);
    if (!ALLOWED_RANGES.has(range)) throw new Error(`Unsupported range: ${range}`);
    const r = await this.fetchChart(symbol, market, interval, range);
    const ts: number[] = r.timestamp ?? [];
    const q = r.indicators?.quote?.[0] ?? {};
    const out: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      if (close == null) continue;
      out.push({
        time: new Date(ts[i] * 1000).toISOString(),
        open: q.open?.[i] ?? close,
        high: q.high?.[i] ?? close,
        low: q.low?.[i] ?? close,
        close,
        volume: q.volume?.[i] ?? 0,
      });
    }
    return out;
  }
}

let provider: PriceProvider = new YahooPriceProvider();

export function getPriceProvider(): PriceProvider {
  return provider;
}

export function setPriceProvider(p: PriceProvider): void {
  provider = p;
}

// ─── Market hours ────────────────────────────────────────────────

const MARKET_SESSIONS: Record<TradingMarket, { tz: string; open: number; close: number }> = {
  // minutes after local midnight
  NSE: { tz: "Asia/Kolkata", open: 9 * 60 + 15, close: 15 * 60 + 30 },
  US: { tz: "America/New_York", open: 9 * 60 + 30, close: 16 * 60 },
};

function localParts(date: Date, tz: string): { weekday: string; minutes: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Regular-session check (Mon–Fri, exchange hours). Exchange holidays are not modelled. */
export function isMarketOpen(market: TradingMarket, now: Date = new Date()): boolean {
  const s = MARKET_SESSIONS[market];
  const { weekday, minutes } = localParts(now, s.tz);
  if (weekday === "Sat" || weekday === "Sun") return false;
  return minutes >= s.open && minutes < s.close;
}

/** Exchange-local calendar date, used to roll the daily P&L baseline. */
export function marketDate(market: TradingMarket, now: Date = new Date()): string {
  return localParts(now, MARKET_SESSIONS[market].tz).ymd;
}
