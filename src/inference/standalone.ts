/**
 * Standalone inference (no Conway API key), e.g. paper trading on a VPS.
 *
 * Upstream routes many models through Conway. Without a Conway key only the
 * providers the creator configured can be called: OpenAI (openaiApiKey),
 * Anthropic (anthropicApiKey) or Ollama (ollamaBaseUrl). This module keeps the
 * router on those, and registers the configured model if the built-in
 * registry does not know it (it ships without Claude models, for example).
 */

import type { AutomatonConfig, ModelEntry, ModelProvider, ModelStrategyConfig } from "../types.js";
import type { ModelRegistry } from "./registry.js";

type Keys = Pick<AutomatonConfig, "openaiApiKey" | "openaiBaseUrl" | "anthropicApiKey" | "ollamaBaseUrl">;

/**
 * @param configuredModels With a custom openaiBaseUrl, only these model IDs are
 *   routed to it: the built-in gpt-* registry entries would not exist there.
 */
export function isModelUsableStandalone(
  entry: ModelEntry,
  keys: Keys,
  configuredModels?: ReadonlySet<string>,
): boolean {
  if (entry.provider === "openai" && keys.openaiBaseUrl && configuredModels && !configuredModels.has(entry.modelId)) {
    return false;
  }
  switch (entry.provider) {
    case "ollama":
      return Boolean(keys.ollamaBaseUrl);
    case "anthropic":
      return Boolean(keys.anthropicApiKey);
    case "openai":
      return Boolean(keys.openaiApiKey);
    default:
      return false;
  }
}

/** Best guess at the provider for a model the registry does not know. */
export function inferStandaloneProvider(modelId: string, keys: Keys): ModelProvider | null {
  if (keys.anthropicApiKey && /^claude/i.test(modelId)) return "anthropic";
  if (keys.openaiApiKey && /^(gpt-|o[1-9]|chatgpt)/i.test(modelId)) return "openai";
  // Custom OpenAI-compatible endpoint (FreeLLMAPI, Groq, OpenRouter...): any model name.
  if (keys.openaiApiKey && keys.openaiBaseUrl) return "openai";
  if (keys.ollamaBaseUrl) return "ollama";
  return null;
}

function standaloneEntry(modelId: string, provider: ModelProvider): ModelEntry {
  const now = new Date().toISOString();
  const isClaude = provider === "anthropic";
  return {
    modelId,
    provider,
    displayName: modelId,
    // Cost unknown here: mark free so it stays usable at every tier.
    // (Spend shown by check_inference_spending will under-count for this model.)
    tierMinimum: "critical",
    costPer1kInput: 0,
    costPer1kOutput: 0,
    maxTokens: 8192,
    contextWindow: isClaude ? 200_000 : 128_000,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: provider === "openai" && /^(gpt-5|o[1-9])/i.test(modelId) ? "max_completion_tokens" : "max_tokens",
    enabled: true,
    lastSeen: now,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Make the configured model(s) routable without Conway:
 * - primary model = config.inferenceModel
 * - register any configured model the registry lacks
 * - low-compute / critical models fall back to the primary if unusable
 * Returns the models that were registered.
 */
export function prepareStandaloneModels(
  registry: ModelRegistry,
  strategy: ModelStrategyConfig,
  config: Keys & { inferenceModel?: string },
): string[] {
  const added: string[] = [];
  if (config.inferenceModel) strategy.inferenceModel = config.inferenceModel;

  const ensure = (modelId: string | undefined): boolean => {
    if (!modelId) return false;
    const existing = registry.get(modelId);
    // With a custom OpenAI-compatible endpoint, built-in gpt-* defaults (e.g. gpt-5-mini as the
    // low-tier model) are not served there; only the primary model the creator chose is.
    if (existing && config.openaiBaseUrl && existing.provider === "openai" && modelId !== strategy.inferenceModel) {
      return false;
    }
    if (existing) return existing.enabled && isModelUsableStandalone(existing, config);
    const provider = inferStandaloneProvider(modelId, config);
    if (!provider) return false;
    registry.upsert(standaloneEntry(modelId, provider));
    added.push(modelId);
    return true;
  };

  ensure(strategy.inferenceModel);
  if (!ensure(strategy.lowComputeModel)) strategy.lowComputeModel = strategy.inferenceModel;
  if (!ensure(strategy.criticalModel)) strategy.criticalModel = strategy.inferenceModel;
  return added;
}
