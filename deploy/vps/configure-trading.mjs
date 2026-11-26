#!/usr/bin/env node
/**
 * Turn on paper-trading mode in ~/.automaton/automaton.json and pick models.
 * Safe to run again; it only changes the fields below. Never prints keys.
 *
 *   node deploy/vps/configure-trading.mjs [--market NSE|US] [--capital 100000]
 *        [--model <id>] [--low-model <id>] [--leverage 5]
 *
 * Free / OpenAI-compatible LLM (FreeLLMAPI, Groq, OpenRouter...):
 *   node deploy/vps/configure-trading.mjs --llm-base-url http://127.0.0.1:3001/v1 --model <name>
 *   It asks for that endpoint's API key without showing it (or keeps the saved one;
 *   pass --ask-key to replace it). The base URL includes the version path (/v1).
 *   Leave out --model to save the URL and key and list the models that endpoint offers.
 *
 * Model defaults (when --model is not given):
 *   Anthropic key present → claude-sonnet-5-5 (low tiers: claude-haiku-5-5)
 *   otherwise OpenAI key  → gpt-5.2 (low tiers: gpt-5-mini)
 *   otherwise Ollama URL  → keep the configured model
 */
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";

/** Read a line from the terminal without echoing it. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    let muted = false;
    rl._writeToOutput = (str) => {
      if (!muted) write(str);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

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
const llmBaseUrl = get("--llm-base-url");
if (llmBaseUrl) {
  if (!/^https?:\/\/[^\s]+$/.test(llmBaseUrl)) {
    console.error("--llm-base-url must look like http://127.0.0.1:3001/v1");
    process.exit(1);
  }
  const baseChanged = cfg.openaiBaseUrl !== llmBaseUrl.replace(/\/+$/, "");
  cfg.openaiBaseUrl = llmBaseUrl.replace(/\/+$/, "");
  if (!cfg.openaiApiKey || baseChanged || args.includes("--ask-key")) {
    const key = await askHidden(`API key for ${cfg.openaiBaseUrl} (input hidden): `);
    if (!key) {
      console.error("No key entered; nothing changed.");
      process.exit(1);
    }
    cfg.openaiApiKey = key;
  }
  if (!model) {
    // Save URL + key, then show what this endpoint serves so the user can pick a model.
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    let ids = [];
    try {
      const res = await fetch(`${cfg.openaiBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${cfg.openaiApiKey}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      // Gemini lists ids as "models/<name>"; its chat endpoint takes the bare <name>.
      ids = (body.data ?? body.models ?? [])
        .map((m) => String(m.id ?? m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean)
        .sort();
    } catch (err) {
      console.error(`Saved the URL and key, but could not list models: ${err.message}`);
      console.error("Check the key and URL, then run again with --model <name> from the provider's docs.");
      process.exit(1);
    }
    console.log(`Saved. Models offered by ${cfg.openaiBaseUrl} (${ids.length}):`);
    for (const id of ids) console.log(`  ${id}`);
    console.log("\nRun again with --model <one of these> to finish (the key is already saved).");
    process.exit(0);
  }
  lowModel ??= model;
} else if (!model) {
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
  cfg.openaiApiKey ? (cfg.openaiBaseUrl ? `OpenAI-compatible (${cfg.openaiBaseUrl})` : "OpenAI") : null,
  cfg.ollamaBaseUrl ? "Ollama" : null,
  cfg.conwayApiKey ? "Conway" : null,
].filter(Boolean);
console.log("Paper trading enabled.");
console.log(`  market:     ${market} (${cfg.trading.currency}), capital ${capital}, max leverage ${leverage}x`);
console.log(`  model:      ${cfg.inferenceModel}${lowModel ? ` (low tiers: ${lowModel})` : ""}`);
console.log(`  providers:  ${providers.join(", ") || "none — add an API key with: node dist/index.js --configure"}`);
console.log(`  config:     ${file}`);
