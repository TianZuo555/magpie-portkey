import { setFetch, parse, chatFetch, type Call, type Save } from "./test-helpers.ts"
import type { Account, Client, MagpiePlugin, WireRecord } from "./types.ts"
import { test, expect } from "bun:test"
import { WorkBuddyAIAuthPlugin, _internal } from "./index.ts"

// modelPromotions as copilot.tencent.com's /v3/config gave them on
// 2026-10-14 (icons left out): Hy4 preview free 23:00–8:00 only, Hy3 free
// for whole days to 10-31, Step-5-Preview free 10-12..10-25
const promotions = [
  { badge: { label: "限时免费", display: "activeOnly" }, discount: { discountedCredits: "0x", displayMode: "replace", factor: 0 }, enabled: true, id: "hy3-free-trial-202608", kind: "discount", modelIds: ["hy3", "hy3-b", "hy3-c"], priority: 200, schedule: { timezone: "Asia/Shanghai", validFrom: "2026-07-06T00:00:00+08:00", validUntil: "2026-11-01T00:00:00+08:00" } },
  { badge: { label: "夜间免费" }, enabled: true, id: "hy4-night-discount-badge-202609", kind: "discount", modelIds: ["hy4-preview", "hy4-preview-ctrl", "hy4-preview-exp"], priority: 50, schedule: { daily: [{ end: "23:00", start: "8:00" }], timezone: "Asia/Shanghai", validFrom: "2026-09-11T00:00:00+08:00", validUntil: "2026-11-01T00:00:00+08:00" } },
  { badge: { label: "夜间免费" }, discount: { discountedCredits: "0.00x", displayMode: "strikethrough", factor: 0 }, enabled: true, id: "hy4-night-discount-daytime-badge-202609", kind: "discount", modelIds: ["hy4-preview", "hy4-preview-ctrl", "hy4-preview-exp"], priority: 50, schedule: { daily: [{ end: "23:59", start: "23:00" }, { end: "8:00", start: "0:00" }], timezone: "Asia/Shanghai", validFrom: "2026-09-11T00:00:00+08:00", validUntil: "2026-11-01T00:00:00+08:00" } },
  { badge: { label: "夜间折扣" }, discount: { discountedCredits: "0.50x", displayMode: "strikethrough", factor: 0.5 }, enabled: true, id: "glm-52-night-discount-202607", kind: "discount", modelIds: ["glm-5.2"], priority: 100, schedule: { daily: [{ end: "7:50", start: "23:00" }], timezone: "Asia/Shanghai" } },
  { badge: { label: "独家限免" }, discount: { discountedCredits: "0.00x", displayMode: "strikethrough", factor: 0 }, enabled: true, id: "step-5-discount-daytime-badge-202610", kind: "discount", modelIds: ["step-5-preview"], priority: 50, schedule: { timezone: "Asia/Shanghai", validFrom: "2026-10-12T00:00:00+08:00", validUntil: "2026-10-26T00:00:00+08:00" } },
  { badge: { label: "夜间折扣" }, enabled: true, id: "ds-discount-daytime-badge-202608", kind: "discount", modelIds: ["deepseek-v4.1-flash"], priority: 50, schedule: { daily: [{ end: "23:59", start: "0:00" }], timezone: "Asia/Shanghai" } },
]
const day = Date.parse("2026-10-14T17:00:00+08:00")
const night = Date.parse("2026-10-14T23:30:00+08:00")

test("a model free only at night is never said free, day or night (#121)", () => {
  for (const at of [day, night]) {
    expect(_internal.priceOf({ id: "hy4-preview", credits: "x0.29" }, promotions, at)).toEqual({ free: false, rate: 0.29 })
    // a list asked for at night whose credits already read 0
    expect(_internal.priceOf({ id: "hy4-preview", credits: "x0.00" }, promotions, at).free).toBe(false)
  }
  expect(_internal.priceOf({ id: "glm-5.2", credits: "x0.79" }, promotions, night)).toEqual({ free: false, rate: 0.79 })
  expect(_internal.priceOf({ id: "deepseek-v4.1-flash", credits: "x0.11" }, promotions, day)).toEqual({ free: false, rate: 0.11 })
})

test("a discount for whole days is the price now, with the price before it", () => {
  expect(_internal.priceOf({ id: "hy3", credits: "x0.00" }, promotions, day)).toEqual({ free: true, rate: 0 })
  expect(_internal.priceOf({ id: "step-5-preview", credits: "x0.40" }, promotions, day)).toEqual({ free: true, rate: 0, rateWas: 0.4 })
  // after it ends, the credits again
  expect(_internal.priceOf({ id: "step-5-preview", credits: "x0.40" }, promotions, Date.parse("2026-10-27T00:00:00+08:00"))).toEqual({ free: false, rate: 0.4 })
})

test("without promotions a model is priced by its credits, as before", () => {
  expect(_internal.priceOf({ id: "hy3", credits: "x0.00" })).toEqual({ free: true, rate: 0 })
  expect(_internal.priceOf({ id: "kimi-k3-1", credits: "x1.62" }, undefined)).toEqual({ free: false, rate: 1.62 })
  expect(_internal.priceOf({ id: "auto" }, promotions)).toEqual({})
})

// International /v3/config returned these aliases with a credits suffix on
// 2026-10-17. Number("0.34 credits") loses an otherwise known multiplier.
test("international credit units preserve alias rates and unknown prices", () => {
  for (const [credits, rate] of [["x0.34 credits", 0.34], ["x0.59 credits", 0.59], ["x0.99 credits", 0.99], ["x0.00 credits", 0]] as const) {
    expect(_internal.priceOf({ id: "fast-model", credits })).toEqual({ free: rate === 0, rate })
  }
  for (const credits of ["", "credits", "x0.34 bananas", "xNaN credits", "xInfinity credits", "x-1 credits"]) {
    expect(_internal.priceOf({ id: "default-model", credits })).toEqual({})
  }
})

test("browser model discovery carries unit-suffixed rates to the host", async () => {
  const real = globalThis.fetch
  setFetch(async (input) => {
    expect(String(input)).toBe("https://www.workbuddy.ai/v3/config")
    return Response.json({ code: 0, data: {
      agents: [{ name: "cli", models: ["default-model", "fast-model", "balanced-model", "primary-model"] }],
      models: [{ id: "default-model", credits: "" }, { id: "fast-model", credits: "x0.34 credits" }, { id: "balanced-model", credits: "x0.59 credits" }, { id: "primary-model", credits: "x0.99 credits" }],
    } })
  })
  try {
    const h = await WorkBuddyAIAuthPlugin({ client: { auth: { set: async () => { throw Error("fixture does not write auth") } } } })
    const config: { provider?: Record<string, WireRecord> } = {}
    await h.config(config)
    const models = await h.provider.models(config.provider["workbuddy-ai"] as import("./types.ts").ProviderInfo, { auth: { type: "oauth", access: "offline-access", expires: Date.now() + 86400000 } })
    expect(models["fast-model"].rate).toBe(0.34)
    expect(models["balanced-model"].rate).toBe(0.59)
    expect(models["primary-model"].rate).toBe(0.99)
    expect(models["default-model"].free).toBe(false)
  } finally { setFetch(real) }
})
