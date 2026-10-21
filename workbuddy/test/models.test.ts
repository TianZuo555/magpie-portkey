// The models WorkBuddy's product config gives its CLI agent, with their
// context, image input and reasoning levels, and the fallback list the package
// ships until WorkBuddy answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { _internal } from "../index.ts";

const { SITES, priceOf, effortsOf, thinkingLevelMap, toPiModel, fallbackModels, enterpriseHeaders } = _internal;

const site = SITES.workbuddy;

test("a model's context, output and images come from the config", () => {
  const model = toPiModel(site, {
    id: "glm-5.3",
    name: "GLM-5.3",
    context: 1_000_000,
    output: 64_000,
    images: true,
    efforts: ["low", "high", "max"],
  });
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 64_000);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  });
});

test("WorkBuddy AI's GLM models are text-only, whatever its config says", () => {
  const glm = toPiModel(SITES["workbuddy-ai"], { id: "glm-5.3", name: "GLM-5.3", images: false });
  assert.deepEqual(glm.input, ["text"]);
  const gpt = toPiModel(SITES["workbuddy-ai"], { id: "gpt-5.5", name: "GPT-5.5", images: true });
  assert.deepEqual(gpt.input, ["text", "image"]);
  // WorkBuddy (China)'s GLM models read them
  const cn = toPiModel(site, { id: "glm-5.3", name: "GLM-5.3", images: true });
  assert.deepEqual(cn.input, ["text", "image"]);
});

test("a model that can turn reasoning off says so", () => {
  const map = thinkingLevelMap(["none", "high", "xhigh"])!;
  assert.equal(map.off, "none");
  assert.equal(map.high, "high");
  assert.equal(map.xhigh, "xhigh");
  assert.equal(map.low, null);
  assert.equal(thinkingLevelMap([]), undefined);
});

test("a model with no supported efforts is not a reasoning model", () => {
  const model = toPiModel(site, { id: "auto", name: "Auto" });
  assert.equal(model.reasoning, false);
  assert.equal(model.thinkingLevelMap, undefined);
});

test("efforts come from the config, or from supportsReasoning and its default", () => {
  assert.deepEqual(effortsOf({ reasoning: { supportedEfforts: ["low", "high"] } }), ["low", "high"]);
  assert.deepEqual(effortsOf({ supportsReasoning: true, reasoning: { effort: "medium" } }), [
    "low",
    "medium",
    "high",
    "max",
  ]);
  assert.deepEqual(effortsOf({ supportsReasoning: true }), ["low", "high", "max"]);
  assert.deepEqual(effortsOf({}), []);
  assert.deepEqual(effortsOf({ supportsReasoning: false, reasoning: { supportedEfforts: [] } }), []);
});

test("a model's price is its credits, and a promotion's", () => {
  // no promotion: the model's own credits
  assert.deepEqual(priceOf({ id: "glm-5.3", credits: "x0.29" }, []), { free: false, rate: 0.29 });
  assert.deepEqual(priceOf({ id: "auto", credits: "" }, []), { free: false });
  assert.deepEqual(priceOf({ id: "free", credits: "x0.00" }, []), { free: true, rate: 0 });
  assert.deepEqual(priceOf({ id: "free", credits: "0" }, []), { free: true, rate: 0 });
  // the international catalog's own words
  assert.deepEqual(priceOf({ id: "fast-model", credits: "x0.34 credits" }, []), { free: false, rate: 0.34 });

  const now = Date.parse("2026-10-13T00:00:00Z");
  const promotion = (extra: Record<string, unknown>) => ({
    kind: "discount",
    modelIds: ["glm-5.3"],
    enabled: true,
    schedule: { validFrom: "2026-10-01T00:00:00Z", validUntil: "2026-11-01T00:00:00Z" },
    ...extra,
  });
  // a discount for whole days is the price now, with the price before it
  assert.deepEqual(priceOf({ id: "glm-5.3", credits: "x0.29" }, [promotion({ discount: { discountedCredits: "0.10x" } })], now), {
    free: false,
    rate: 0.1,
    rateWas: 0.29,
  });
  // a promotion that isn't on is not the price
  assert.deepEqual(
    priceOf({ id: "glm-5.3", credits: "x0.29" }, [{ ...promotion({ discount: { factor: 0 } }), enabled: false }], now),
    { free: false, rate: 0.29 },
  );
  // one that ended is not either
  assert.deepEqual(
    priceOf(
      { id: "glm-5.3", credits: "x0.29" },
      [promotion({ discount: { factor: 0 }, schedule: { validFrom: "2026-09-01T00:00:00Z", validUntil: "2026-10-01T00:00:00Z" } })],
      now,
    ),
    { free: false, rate: 0.29 },
  );
});

test("a price that holds only some hours of the day is the full price, never free", () => {
  const now = Date.parse("2026-10-13T02:00:00Z");
  const night = {
    kind: "discount",
    modelIds: ["hy4-preview-f"],
    enabled: true,
    discount: { discountedCredits: "0.00x" },
    schedule: { validFrom: "2026-10-01T00:00:00Z", validUntil: "2026-11-01T00:00:00Z", daily: [{ from: 23, to: 8 }] },
  };
  // the model's own credits are the price, so a list asked for at night
  // doesn't say "free" all day
  assert.deepEqual(priceOf({ id: "hy4-preview-f", credits: "x0.20" }, [night], now), { free: false, rate: 0.2 });
  assert.deepEqual(priceOf({ id: "hy4-preview-f", credits: "x0.00" }, [night], now), { free: false });
});

test("the shipped list is pi's, and every model says what it takes", () => {
  for (const site of Object.values(SITES)) {
    const models = fallbackModels(site);
    assert.ok(models.length > 0);
    assert.equal(new Set(models.map((m) => m.id)).size, models.length, `${site.id}'s ids are unique`);
    for (const model of models) {
      assert.equal(model.provider, site.id);
      assert.equal(model.api, "workbuddy-openai-completions");
      assert.ok(model.contextWindow >= 100_000);
      assert.ok(model.maxTokens > 0);
      assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  }
  assert.ok(fallbackModels(SITES.workbuddy).some((m) => m.id === "deepseek-v4-pro"));
  assert.ok(fallbackModels(SITES["workbuddy-ai"]).some((m) => m.id === "gemini-3.5-flash"));
});

test("an enterprise account names its enterprise on every request", () => {
  assert.deepEqual(enterpriseHeaders({ enterpriseId: "ent-9" } as any), {
    "X-Enterprise-Id": "ent-9",
    "X-Tenant-Id": "ent-9",
  });
  assert.deepEqual(enterpriseHeaders({} as any), {});
  assert.deepEqual(enterpriseHeaders({ enterpriseId: "  " } as any), {});
});
