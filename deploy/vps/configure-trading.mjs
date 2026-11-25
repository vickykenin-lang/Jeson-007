#!/usr/bin/env node
/**
 * Turn on paper-trading mode in ~/.automaton/automaton.json and pick models.
 * Safe to run again; it only changes the fields below. Never prints keys.
 *
 *   node deploy/vps/configure-trading.mjs [--market NSE|US] [--capital 100000]
 *        [--model <id>] [--low-model <id>] [--leverage 5]
 *
 * Model defaults (when --model is not given):
 *   Anthropic key present → claude-sonnet-5-5 (low tiers: claude-haiku-5-5)
 *   otherwise OpenAI key  → gpt-5.2 (low tiers: gpt-5-mini)
 *   otherwise Ollama URL  → keep the configured model
 */
import fs from "fs";
import os from "os";
import path from "path";

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

const file = path.join(os.homedir(), ".automaton", "automaton.json");
if (!fs.existsSync(file)) {
  console.error(`Not found: ${file}\nRun the setup wizard first: node dist/index.js --setup`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));

const market = (get("--market") ?? cfg.trading?.market ?? "NSE").toUpperCase();
if (market !== "NSE" && market !== "US") {
  console.error("--market must be NSE or US");
  process.exit(1);
}
const capital = Number(get("--capital") ?? cfg.trading?.startingCapital ?? 100000);
const leverage = Number(get("--leverage") ?? cfg.trading?.maxLeverage ?? 5);

cfg.trading = {
  ...(cfg.trading ?? {}),
  enabled: true,
  market,
  currency: market === "US" ? "USD" : "INR",
  startingCapital: capital,
  maxLeverage: leverage,
};

let model = get("--model");
let lowModel = get("--low-model");
if (!model) {
  if (cfg.anthropicApiKey) {
    model = "claude-sonnet-5-5";
    lowModel ??= "claude-haiku-5-5";
  } else if (cfg.openaiApiKey) {
    model = "gpt-5.2";
    lowModel ??= "gpt-5-mini";
  } else {
    model = cfg.inferenceModel;
  }
}
if (model) cfg.inferenceModel = model;
cfg.modelStrategy = {
  ...(cfg.modelStrategy ?? {}),
  inferenceModel: model ?? cfg.modelStrategy?.inferenceModel,
  ...(lowModel ? { lowComputeModel: lowModel, criticalModel: lowModel } : {}),
};

fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });

const providers = [
  cfg.anthropicApiKey ? "Anthropic" : null,
  cfg.openaiApiKey ? "OpenAI" : null,
  cfg.ollamaBaseUrl ? "Ollama" : null,
  cfg.conwayApiKey ? "Conway" : null,
].filter(Boolean);
console.log("Paper trading enabled.");
console.log(`  market:     ${market} (${cfg.trading.currency}), capital ${capital}, max leverage ${leverage}x`);
console.log(`  model:      ${cfg.inferenceModel}${lowModel ? ` (low tiers: ${lowModel})` : ""}`);
console.log(`  providers:  ${providers.join(", ") || "none — add an API key with: node dist/index.js --configure"}`);
console.log(`  config:     ${file}`);
