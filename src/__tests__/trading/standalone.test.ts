/**
 * Standalone inference (no Conway key): the router must only pick models the
 * runtime can actually call, and the configured model must be routable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelRegistry } from "../../inference/registry.js";
import { InferenceBudgetTracker } from "../../inference/budget.js";
import { InferenceRouter } from "../../inference/router.js";
import { isModelUsableStandalone, prepareStandaloneModels } from "../../inference/standalone.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG, type AutomatonDatabase, type ModelStrategyConfig } from "../../types.js";
import { createTestDb } from "../mocks.js";

function setup(db: AutomatonDatabase, keys: { anthropicApiKey?: string; openaiApiKey?: string; ollamaBaseUrl?: string; inferenceModel?: string }, standalone = true) {
  const registry = new ModelRegistry(db.raw);
  registry.initialize();
  const strategy: ModelStrategyConfig = { ...DEFAULT_MODEL_STRATEGY_CONFIG };
  if (standalone) prepareStandaloneModels(registry, strategy, keys);
  const router = new InferenceRouter(
    db.raw,
    registry,
    new InferenceBudgetTracker(db.raw, strategy),
    standalone ? (e) => isModelUsableStandalone(e, keys) : undefined,
  );
  return { registry, strategy, router };
}

describe("standalone model routing", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("Anthropic key + Claude model: registers it and routes every tier to it", () => {
    const keys = { anthropicApiKey: "k", inferenceModel: "claude-sonnet-5-5" };
    const { registry, router } = setup(db, keys);
    expect(registry.get("claude-sonnet-5-5")?.provider).toBe("anthropic");
    for (const tier of ["high", "normal", "low_compute", "critical"] as const) {
      expect(router.selectModel(tier, "agent_turn")?.modelId, tier).toBe("claude-sonnet-5-5");
    }
  });

  it("uses a configured cheaper model on low tiers", () => {
    const keys = { anthropicApiKey: "k", inferenceModel: "claude-sonnet-5-5" };
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const strategy: ModelStrategyConfig = { ...DEFAULT_MODEL_STRATEGY_CONFIG, lowComputeModel: "claude-haiku-5-5", criticalModel: "claude-haiku-5-5" };
    prepareStandaloneModels(registry, strategy, keys);
    const router = new InferenceRouter(db.raw, registry, new InferenceBudgetTracker(db.raw, strategy), (e) => isModelUsableStandalone(e, keys));
    expect(router.selectModel("high", "agent_turn")?.modelId).toBe("claude-sonnet-5-5");
    expect(router.selectModel("critical", "agent_turn")?.modelId).toBe("claude-haiku-5-5");
  });

  it("never routes to OpenAI/Conway models without their keys", () => {
    const keys = { anthropicApiKey: "k", inferenceModel: "claude-sonnet-5-5" };
    const { router } = setup(db, keys);
    expect(router.selectModel("high", "agent_turn")?.provider).toBe("anthropic");
  });

  it("OpenAI key: built-in gpt models are usable", () => {
    const keys = { openaiApiKey: "k", inferenceModel: "gpt-5.2" };
    const { router } = setup(db, keys);
    expect(router.selectModel("high", "agent_turn")?.modelId).toBe("gpt-5.2");
  });

  it("no usable key: no model is selected (runtime logs a clear error)", () => {
    const { router } = setup(db, { inferenceModel: "gpt-5.2" });
    expect(router.selectModel("high", "agent_turn")).toBeNull();
  });

  it("custom OpenAI-compatible endpoint (FreeLLMAPI etc.): routes only to the configured model", () => {
    const keys = { openaiApiKey: "k", openaiBaseUrl: "http://127.0.0.1:3001/v1", inferenceModel: "free-model-x" };
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const strategy: ModelStrategyConfig = { ...DEFAULT_MODEL_STRATEGY_CONFIG };
    prepareStandaloneModels(registry, strategy, keys);
    const configured = new Set([strategy.inferenceModel, strategy.lowComputeModel, strategy.criticalModel]);
    const router = new InferenceRouter(
      db.raw,
      registry,
      new InferenceBudgetTracker(db.raw, strategy),
      (e) => isModelUsableStandalone(e, keys, configured),
    );
    expect(registry.get("free-model-x")?.provider).toBe("openai");
    for (const tier of ["high", "normal", "low_compute", "critical"] as const) {
      // never the built-in gpt-5.2 entry, which the gateway would not serve
      expect(router.selectModel(tier, "agent_turn")?.modelId, tier).toBe("free-model-x");
    }
  });

  it("custom endpoint model stays routable after a restart (registry.initialize disables non-baseline models)", () => {
    const keys = { openaiApiKey: "k", openaiBaseUrl: "https://example.test/v1beta/openai", inferenceModel: "gemini-x-flash" };
    const route = () => {
      const registry = new ModelRegistry(db.raw);
      registry.initialize();
      const strategy: ModelStrategyConfig = { ...DEFAULT_MODEL_STRATEGY_CONFIG };
      prepareStandaloneModels(registry, strategy, keys);
      const configured = new Set([strategy.inferenceModel, strategy.lowComputeModel, strategy.criticalModel]);
      const router = new InferenceRouter(db.raw, registry, new InferenceBudgetTracker(db.raw, strategy), (e) =>
        isModelUsableStandalone(e, keys, configured),
      );
      return router.selectModel("high", "agent_turn")?.modelId;
    };
    expect(route()).toBe("gemini-x-flash"); // first start
    expect(route()).toBe("gemini-x-flash"); // restart on the same database
    expect(route()).toBe("gemini-x-flash");
  });

  it("with Conway (no filter) routing is unchanged", () => {
    const { router } = setup(db, {}, false);
    expect(router.selectModel("high", "agent_turn")?.modelId).toBe("gpt-5.2");
  });
});
