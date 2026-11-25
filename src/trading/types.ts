/**
 * Paper Trading Types & Defaults
 *
 * Trading mode turns the automaton into a paper (simulated) stock trader.
 * Its survival tier is derived from paper equity instead of Conway credits:
 * profitable trading keeps it alive, losses push it toward "dead".
 */

export type TradingMarket = "NSE" | "US";

export interface TradingConfig {
  /** Master switch. When false/absent the automaton behaves as upstream. */
  enabled: boolean;
  /** Which market to trade. Decides symbol format, hours and timezone. */
  market: TradingMarket;
  /** Account currency label (display only). */
  currency: string;
  /** Paper capital the account starts with. */
  startingCapital: number;

  // ── Leverage & margin ──
  /** Max gross exposure / equity after any risk-increasing order. */
  maxLeverage: number;
  /**
   * Margin call: when equity falls below this % of gross exposure,
   * every position is force-closed at market (like a real broker).
   */
  maintenanceMarginPct: number;
  /** Allow selling more than held (short positions). */
  allowShort: boolean;

  // ── Risk limits ──
  /** Max notional in one symbol, as % of buying power (equity × maxLeverage). */
  maxSinglePositionPct: number;
  /** Max number of distinct open positions. */
  maxOpenPositions: number;
  /** Block new risk once equity is this % below the day's starting equity. */
  dailyLossLimitPct: number;
  /** Max orders in any rolling 60 minutes. */
  maxOrdersPerHour: number;
  /** Reject orders outside regular market hours. */
  enforceMarketHours: boolean;
  /** Quote used by the pre-trade policy check must be newer than this. */
  quoteMaxAgeSeconds: number;

  // ── Execution realism ──
  /** Fees per side, in basis points of notional. */
  feeBps: number;
  /** Adverse slippage applied to every fill, in basis points. */
  slippageBps: number;

  // ── Survival tiers (equity as % of starting capital) ──
  tierThresholdsPct: {
    /** At or above this → normal (at or above 100% → high). */
    normal: number;
    /** At or above this → low_compute. */
    lowCompute: number;
    /** Above this → critical. At or below → dead (account blown). */
    critical: number;
  };
}

export const DEFAULT_TRADING_CONFIG: TradingConfig = {
  enabled: false,
  market: "NSE",
  currency: "INR",
  startingCapital: 100_000,

  maxLeverage: 5,
  maintenanceMarginPct: 10,
  allowShort: true,

  maxSinglePositionPct: 50,
  maxOpenPositions: 10,
  dailyLossLimitPct: 15,
  maxOrdersPerHour: 60,
  enforceMarketHours: true,
  quoteMaxAgeSeconds: 300,

  feeBps: 5,
  slippageBps: 5,

  tierThresholdsPct: {
    normal: 60,
    lowCompute: 30,
    critical: 10,
  },
};

/** Merge a partial (user) trading config over the defaults. */
export function resolveTradingConfig(
  raw: Partial<TradingConfig> | undefined,
): TradingConfig {
  const merged: TradingConfig = {
    ...DEFAULT_TRADING_CONFIG,
    ...(raw ?? {}),
    tierThresholdsPct: {
      ...DEFAULT_TRADING_CONFIG.tierThresholdsPct,
      ...(raw?.tierThresholdsPct ?? {}),
    },
  };
  if (raw?.market === "US" && raw.currency === undefined) {
    merged.currency = "USD";
  }
  // Positive-number sanity: fall back to defaults on bad values.
  const numericKeys: (keyof TradingConfig)[] = [
    "startingCapital", "maxLeverage", "maintenanceMarginPct",
    "maxSinglePositionPct", "maxOpenPositions", "dailyLossLimitPct",
    "maxOrdersPerHour", "quoteMaxAgeSeconds", "feeBps", "slippageBps",
  ];
  for (const key of numericKeys) {
    const v = merged[key] as unknown;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      (merged as any)[key] = DEFAULT_TRADING_CONFIG[key];
    }
  }
  if (merged.maxLeverage < 1) merged.maxLeverage = 1;
  return merged;
}

export type OrderSide = "buy" | "sell";

export interface Quote {
  symbol: string;
  price: number;
  /** ISO time of the price (exchange time). */
  asOf: string;
  currency?: string;
}

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Position {
  symbol: string;
  /** Signed: positive = long, negative = short. */
  quantity: number;
  avgPrice: number;
  lastPrice: number;
  lastPriceAt: string;
}

export interface AccountSnapshot {
  cash: number;
  positions: Position[];
  marketValue: number;
  equity: number;
  grossExposure: number;
  leverage: number;
  startingCapital: number;
  dayStartEquity: number;
  dayPnl: number;
  realizedPnl: number;
}

export interface Fill {
  id: string;
  time: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  fee: number;
  realizedPnl: number;
  reason: "agent" | "margin_call";
}
