/**
 * Trading-mode tool allowlist.
 *
 * In trading mode the agent keeps only what it needs to trade, remember,
 * reflect and report. Everything that spends real money (credit transfers,
 * top-ups, sandboxes, domains, children), changes its own code or rules,
 * or opens a side channel around the paper ledger (shell, git, package /
 * skill / MCP installs, upstream pulls) is removed.
 */

import type { AutomatonTool } from "../types.js";

export const TRADING_MODE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  // Notes / journal (writes further restricted by trading.write_scope rule)
  "read_file",
  "write_file",
  // Survival & status (read-only real-compute awareness)
  "check_credits",
  "system_synopsis",
  "heartbeat_ping",
  "sleep",
  // Memory
  "remember_fact",
  "recall_facts",
  "set_goal",
  "complete_goal",
  "save_procedure",
  "recall_procedure",
  "review_memory",
  "forget",
  // Soul / identity evolution
  "update_soul",
  "reflect_on_soul",
  "view_soul",
  "view_soul_history",
  // Model choice (survival tiers already downgrade automatically)
  "list_models",
  "switch_model",
  "check_inference_spending",
  // Talk to creator
  "send_message",
]);

/** Keep allowlisted built-ins, then append the trading tools. */
export function selectTradingModeTools(
  builtinTools: AutomatonTool[],
  tradingTools: AutomatonTool[],
): AutomatonTool[] {
  return [
    ...builtinTools.filter((t) => TRADING_MODE_BUILTIN_TOOLS.has(t.name)),
    ...tradingTools,
  ];
}
