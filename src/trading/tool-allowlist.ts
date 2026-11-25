/**
 * Trading-mode tool allowlist.
 *
 * In trading mode the agent keeps what it needs to trade, research,
 * remember, reflect and report. It has a shell and research sandboxes for
 * internet R&D and analysis; the ledger, config and trading code are
 * guarded (trading.exec_guard + tamper seal) and sandbox spend is capped
 * (trading.sandbox_limits). Removed: credit transfers and top-ups, domains,
 * ports, child agents, self-editing code, upstream pulls, genesis and
 * heartbeat edits, and the orchestrator.
 */

import type { AutomatonTool } from "../types.js";

export const TRADING_MODE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  // Research & analysis: shell (curl, python, pip ...) in the sandbox, extra sandboxes
  "exec",
  "create_sandbox",
  "list_sandboxes",
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
