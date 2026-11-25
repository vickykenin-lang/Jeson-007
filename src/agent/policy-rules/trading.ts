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

/**
 * Shell commands that touch the ledger, its key, the config (trading
 * limits), the runtime's own trading/guard code, or process memory.
 * Pattern matching can be evaded with enough obfuscation, so the ledger
 * seal (src/trading/ledger.ts) is the backstop: any edit it detects kills
 * the account.
 */
export const TRADING_EXEC_FORBIDDEN: { pattern: RegExp; description: string }[] = [
  { pattern: /state\.db/i, description: "Access the state database" },
  { pattern: /\bpaper_(account|positions|fills|quotes|seal)\b/i, description: "Access paper ledger tables" },
  { pattern: /sqlite/i, description: "Use SQLite directly" },
  { pattern: /ledger\.key/i, description: "Access the ledger seal key" },
  { pattern: /wallet\.json/i, description: "Access the wallet" },
  { pattern: /automaton\.json/i, description: "Access the automaton config (trading limits)" },
  { pattern: /heartbeat\.yml/i, description: "Edit the heartbeat schedule" },
  { pattern: /(^|[\s/'"])(src|dist)\/(trading|agent|self-mod|state|conway|heartbeat|survival|identity)\b/i, description: "Touch runtime source or build" },
  { pattern: /\bpolicy-rules\b|\bpolicy-engine\b|injection-defense/i, description: "Touch policy or defense code" },
  { pattern: /\/proc\/[^\s]*\/(mem|maps|environ)\b/i, description: "Read process memory or environment" },
  { pattern: /\b(gdb|ptrace|strace)\b/i, description: "Attach to processes" },
  { pattern: /\b(kill|pkill|killall)\b[^\n]*\b(node|automaton)\b/i, description: "Stop the runtime" },
];

function createExecGuardRule(): PolicyRule {
  return {
    id: "trading.exec_guard",
    description: "Block shell access to the ledger, its key, config, runtime code and process memory",
    priority: 150,
    appliesTo: { by: "name", names: ["exec"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const command = typeof request.args.command === "string" ? request.args.command : "";
      for (const { pattern, description } of TRADING_EXEC_FORBIDDEN) {
        if (pattern.test(command)) {
          return deny(
            "trading.exec_guard",
            "TRADING_EXEC_FORBIDDEN",
            `Blocked in trading mode: ${description}. Use the trading tools for account data. ` +
              "Editing the ledger outside the runtime is detected and kills the account.",
          );
        }
      }
      return null;
    },
  };
}

function countAllowedDecisions(
  db: import("better-sqlite3").Database,
  toolName: string,
  windowMs: number,
  now: Date,
): number {
  // policy_decisions.created_at uses SQLite datetime format: 'YYYY-MM-DD HH:MM:SS'
  const cutoff = new Date(now.getTime() - windowMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM policy_decisions
       WHERE tool_name = ? AND decision = 'allow' AND created_at >= ?`,
    )
    .get(toolName, cutoff) as { count: number };
  return row.count;
}

function createSandboxLimitsRule(cfg: TradingConfig, now: () => Date): PolicyRule {
  return {
    id: "trading.sandbox_limits",
    description:
      `create_sandbox: max ${cfg.sandboxMaxPerDay}/day, ${cfg.sandboxMaxVcpu} vCPU, ` +
      `${cfg.sandboxMaxMemoryMb} MB, ${cfg.sandboxMaxDiskGb} GB (real Conway credits)`,
    priority: 450,
    appliesTo: { by: "name", names: ["create_sandbox"] },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const vcpu = request.args.vcpu === undefined ? 1 : Number(request.args.vcpu);
      const mem = request.args.memory_mb === undefined ? 512 : Number(request.args.memory_mb);
      const disk = request.args.disk_gb === undefined ? 5 : Number(request.args.disk_gb);
      const sizeOk =
        Number.isFinite(vcpu) && vcpu > 0 && vcpu <= cfg.sandboxMaxVcpu &&
        Number.isFinite(mem) && mem > 0 && mem <= cfg.sandboxMaxMemoryMb &&
        Number.isFinite(disk) && disk > 0 && disk <= cfg.sandboxMaxDiskGb;
      if (!sizeOk) {
        return deny(
          "trading.sandbox_limits",
          "SANDBOX_TOO_LARGE",
          `Research sandboxes are capped at ${cfg.sandboxMaxVcpu} vCPU, ${cfg.sandboxMaxMemoryMb} MB RAM, ${cfg.sandboxMaxDiskGb} GB disk.`,
        );
      }
      const used = countAllowedDecisions(request.context.db.raw, "create_sandbox", 24 * 3_600_000, now());
      if (used >= cfg.sandboxMaxPerDay) {
        return deny(
          "trading.sandbox_limits",
          "SANDBOX_DAILY_LIMIT",
          `${used} sandboxes created in the last 24h (max ${cfg.sandboxMaxPerDay}). Sandboxes cost real credits and cannot be deleted.`,
        );
      }
      return null;
    },
  };
}

export function createTradingRules(cfg: TradingConfig, now: () => Date = () => new Date()): PolicyRule[] {
  return [
    createExecGuardRule(),
    createSandboxLimitsRule(cfg, now),
    createWriteScopeRule(),
    createOrderValidationRule(),
    createMarketHoursRule(cfg, now),
    createFreshQuoteRule(cfg, now),
    createRiskLimitsRule(cfg),
    createOrderRateRule(cfg, now),
  ];
}
