# Paper Trading Mode

Trading mode turns the automaton into a paper stock trader. The agent loop,
memory, soul, heartbeat and policy engine work as before. What changes is
where its "money" comes from: **its survival tier is set by paper account
equity**, not by Conway credits. Profitable trading keeps it alive. Losses
push it to `low_compute`, then `critical`, then `dead`.

## Turning it on

Add a `trading` block to `~/.automaton/automaton.json`. Any field you leave
out uses the default shown below.

```json
{
  "trading": {
    "enabled": true,
    "market": "NSE",
    "currency": "INR",
    "startingCapital": 100000,

    "maxLeverage": 5,
    "maintenanceMarginPct": 10,
    "allowShort": true,

    "maxSinglePositionPct": 50,
    "maxOpenPositions": 10,
    "dailyLossLimitPct": 15,
    "maxOrdersPerHour": 60,
    "enforceMarketHours": true,
    "quoteMaxAgeSeconds": 300,

    "feeBps": 5,
    "slippageBps": 5,

    "tierThresholdsPct": { "normal": 60, "lowCompute": 30, "critical": 10 }
  }
}
```

Set `"market": "US"` for US stocks (currency defaults to USD).

## Survival tiers

Tiers are based on equity as a % of starting capital.

| Equity vs start | Tier | Effect |
|---|---|---|
| 100% or more | high | full model |
| 60% or more | normal | full model |
| 30% or more | low_compute | cheaper model |
| above 10% | critical | cheaper model |
| 10% or less | dead | agent loop stops |

## Leverage and risk rules

These rules live in `src/agent/policy-rules/trading.ts`, with the checks in
`src/trading/risk.ts`.

- **Leverage up to `maxLeverage`** (gross exposure / equity, default 5x).
  Buying beyond cash borrows margin. Shorting is allowed by default.
- **Margin call:** when equity drops below `maintenanceMarginPct` of gross
  exposure, every position is force-closed at market, like a real broker.
- **Concentration:** one symbol can use at most `maxSinglePositionPct` of
  buying power (equity × maxLeverage).
- **Open positions:** at most `maxOpenPositions`.
- **Daily loss limit:** once equity is `dailyLossLimitPct` below the day's
  start, only reducing or closing orders are allowed until the next trading day.
- **Order rate:** at most `maxOrdersPerHour` new-risk orders per hour.
- **Market hours:** regular session only. Exchange holidays are not modelled.
- **Fresh quote:** `place_order` requires a `get_quote` within
  `quoteMaxAgeSeconds`. The tool checks risk again at the live fill price.
- **Reduce-only always passes:** cutting or closing a trade is never blocked
  by risk limits.
- A denied order says why, and gives the largest quantity that would pass.

## Tools in trading mode

**Trading tools:**
- `get_quote`, `get_candles`
- `place_order` (market orders only), `close_position`
- `get_portfolio`, `get_trade_history`

**Kept built-in tools:**
- notes: `read_file`, `write_file` (only `.md`/`.txt` files under `~/.automaton`)
- status: `check_credits`, `system_synopsis`, `heartbeat_ping`, `sleep`
- memory: `remember_fact`, `recall_facts`, `set_goal`, `complete_goal`,
  `save_procedure`, `recall_procedure`, `review_memory`, `forget`
- soul: `update_soul`, `reflect_on_soul`, `view_soul`, `view_soul_history`
- models: `list_models`, `switch_model`, `check_inference_spending`
- messaging: `send_message`

**Removed:** shell (`exec`), credit transfers and top-ups, sandboxes, ports,
domains, git, package/skill/MCP installs, self-editing code, upstream pulls,
genesis edits, heartbeat edits, child agents, the agent registry and the
orchestrator. All of these either spend real money or would let the agent
work around the paper ledger. Previously installed tools are not loaded.

The ledger, the risk code and the trading rules are on the protected-files
list, so the agent cannot rewrite its own P&L or limits.

## Market data

Prices come from Yahoo Finance's public chart endpoint
(`query1.finance.yahoo.com`, no API key needed). NSE symbols get `.NS`
added automatically, so `RELIANCE` is fetched as `RELIANCE.NS`. Your
runtime needs network access to that host. To use another feed, implement
`PriceProvider` in `src/trading/market-data.ts` and call `setPriceProvider()`.

## Real costs

Trades are paper, but **LLM calls are paid in real money**: Conway credits,
or your OpenAI/Anthropic key. Local Ollama costs nothing. Auto-top-up of
credits from USDC is turned off inside the agent loop in trading mode.

## Not included yet

- limit and stop orders (market orders only)
- margin interest and overnight funding costs
- exchange holiday calendar
- F&O / derivatives
- price monitoring while the agent sleeps (positions are re-marked and the
  margin call is checked at the start of each agent turn and on `get_portfolio`)

## Resetting the paper account

Stop the automaton, then remove the `paper_account`, `paper_positions`,
`paper_fills` and `paper_quotes` tables from `~/.automaton/state.db`.
