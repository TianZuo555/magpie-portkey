import { setFetch, parse, chatFetch, type Call, type Save } from "./test-helpers.ts"
import type { Account, Client, MagpiePlugin, WireRecord } from "./types.ts"
// plugins#255 (kylesean): eight models in WorkBuddy's /v3/config say
// supportsReasoning and a default reasoning.effort but no
// reasoning.supportedEfforts, so the plugin listed them as not reasoning.
// testdata/config-efforts.json is WorkBuddy AI's own config (2026-10-20,
// descriptions left out), cut to those models and a few beside them.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { _internal } from "./index.ts"

const real = globalThis.fetch
afterEach(() => (setFetch(real)))

const config = readFileSync(new URL("./testdata/config-efforts.json", import.meta.url), "utf8")

async function listed() {
  setFetch(async () => new Response(config))
  const out = await _internal.liveModels(_internal.SITES["workbuddy-ai"], { access: "a", uid: "u" })
  return Object.fromEntries(out.map((m) => [m.id, m.efforts]))
}

test("a model that says only supportsReasoning and a default takes low, high, max and its default", async () => {
  const e = await listed()
  expect(e["fast-model"]).toEqual(["low", "medium", "high", "max"])
  expect(e["kimi-k3"]).toEqual(["low", "medium", "high", "max"])
  expect(e["gemini-3.5-flash"]).toEqual(["low", "medium", "high", "max"])
  expect(e["primary-model"]).toEqual(["low", "high", "max"])
  expect(e["deepseek-v4.1-flash-sg"]).toEqual(["low", "high", "max"])
})

test("listed efforts are kept as they are, and a model that doesn't reason gets none", async () => {
  const e = await listed()
  expect(e["hy3"]).toEqual(["low", "high"])
  expect(e["gpt-5.6-sol"]).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  expect(e["glm-5.2"]).toEqual(["none", "high", "xhigh"])
  expect(e["default-model"]).toBeUndefined()
})
