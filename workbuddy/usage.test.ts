import { setFetch, parse, chatFetch, type Call, type Save } from "./test-helpers.ts"
import type { Account, Client, MagpiePlugin, WireRecord } from "./types.ts"
// auth.usage tells what magpie's built-in WorkBuddy usage told for the same
// answers (internal/provider/workbuddy_test.go, workbuddy_ai_test.go).
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"
import { join } from "node:path"

let WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal, home
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test, so
  // no real sign-in is ever read
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  home = homedir()
  ;({ WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } = await import("./index.ts"))
})
// nothing leaves the machine; the fetch this file found is put back when
// it is done, so the next test file (bun runs them all in one process)
// doesn't inherit offline: qoder's cn.test.mjs, taking it as the real
// fetch, sent its stand-in's requests nowhere and its sign-in polled on
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
setFetch(offline)
afterAll(() => (setFetch(real)))
afterEach(() => {
  setFetch(offline)
  _internal.desktopHeld.clear()
})

const later = () => Date.now() + 3600_000
const ok = (data) => new Response(JSON.stringify({ code: 0, msg: "ok", data }))
// the summary as the live API sends it: capacities as strings, some fractional
const PAID = { IsPaidUser: true, Packages: [
  { PackageCode: "coding", CycleTotalCapacity: "9500", CycleRemainCapacity: "7500", CycleUsedCapacity: "2000" },
  { PackageCode: "vibe", CycleTotalCapacity: "500", CycleRemainCapacity: "0", CycleUsedCapacity: "500.00000000" },
] }

function serve(routes) {
  const calls = []
  setFetch(async (url, init) => {
    const u = new URL(String(url))
    calls.push({ url: u, init, headers: new Headers(init?.headers) })
    const r = routes[u.pathname]
    return r ? r(init) : new Response("", { status: 404 })
  })
  return calls
}
const usageOf = async (plugin, auth, client = {}) => (await plugin({ client })).auth.usage(async () => auth)

test("a paid WorkBuddy account's credits", async () => {
  const calls = serve({ "/billing/meter/get-user-resource-summary": () => ok(PAID) })
  const auth = { type: "oauth", access: "two-access", refresh: "r", expires: later(), uid: "u2", domain: "" }
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ signIn: "kept", plan: "Pro", windows: [{ name: "Credits", used: 25, display: "2500 / 10000", amount: 2500, limit: 10000, unit: "credits" }] })
  const c = calls[0]
  expect(c.url.origin).toBe("https://copilot.tencent.com")
  expect(c.init.method).toBe("POST")
  expect(c.init.body).toBe("{}")
  expect(Object.fromEntries(["authorization", "x-user-id", "x-domain", "x-product", "x-ide-type", "user-agent"].map((h) => [h, c.headers.get(h)])))
    .toEqual({ authorization: "Bearer two-access", "x-user-id": "u2", "x-domain": "copilot.tencent.com", "x-product": "SaaS",
      "x-ide-type": "WorkBuddy", "user-agent": "WorkBuddy/5.5.6" })
})

test("a free WorkBuddy AI account, at its own site and domain", async () => {
  const calls = serve({ "/billing/meter/get-user-resource-summary": () =>
    ok({ IsPaidUser: false, Packages: [{ CycleTotalCapacity: "1000", CycleUsedCapacity: "100" }] }) })
  const auth = { type: "oauth", access: "ai-access", expires: later(), uid: "ai2", domain: "www.codebuddy.ai" }
  expect(await usageOf(WorkBuddyAIAuthPlugin, auth)).toEqual({ signIn: "kept", plan: "Free", windows: [{ name: "Credits", used: 10, display: "100 / 1000", amount: 100, limit: 1000, unit: "credits" }] })
  expect(calls[0].url.origin).toBe("https://www.workbuddy.ai")
  expect(calls[0].headers.get("x-domain")).toBe("www.codebuddy.ai")
})

test("counts and plans as Go says them", () => {
  expect(_internal.usageOf({ IsPaidUser: true, Packages: [{ CycleTotalCapacity: 3300, CycleUsedCapacity: "438.88000002" }, {}] }, "Team"))
    .toEqual({ plan: "Team", windows: [{ name: "Credits", used: (100 * 438.88000002) / 3300, display: "438.88 / 3300", amount: 438.88000002, limit: 3300, unit: "credits" }] })
  // no capacity, no window
  expect(_internal.usageOf({ IsPaidUser: false, Packages: [{ CycleTotalCapacity: "", CycleUsedCapacity: null }] }, ""))
    .toEqual({ plan: "Free", windows: [] })
  expect(() => _internal.usageOf({ Packages: [{ CycleTotalCapacity: "lots" }] })).toThrow('strconv.ParseFloat: parsing "lots": invalid syntax')
})

test("WorkBuddy's refusals are the card's error", async () => {
  const auth = { type: "oauth", access: "a", expires: later(), uid: "u" }
  serve({ "/billing/meter/get-user-resource-summary": () => new Response("", { status: 401 }) })
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ signIn: "kept", error: "Unauthorized" })
  serve({ "/billing/meter/get-user-resource-summary": () => new Response(JSON.stringify({ code: 10085, msg: "" }), { status: 403 }) })
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ signIn: "kept", error: "error 10085" })
  serve({ "/billing/meter/get-user-resource-summary": () => new Response(JSON.stringify({ code: 11001, msg: "token expired" })) })
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ signIn: "kept", error: "token expired" })
  expect(await usageOf(WorkBuddyAuthPlugin, null)).toEqual({ signIn: "kept", error: "not signed in" })
})

// Go's http.StatusText has words for every status WorkBuddy may give, and
// the card must never get an empty error
test("any refused status is an error with words", async () => {
  const auth = { type: "oauth", access: "a", expires: later(), uid: "u" }
  for (const [status, said] of [[409, "Conflict"], [402, "Payment Required"], [422, "Unprocessable Entity"], [501, "Not Implemented"], [520, "HTTP 520"], [302, "Found"]] as const) {
    serve({ "/billing/meter/get-user-resource-summary": () => new Response("", { status }) })
    expect([status, await usageOf(WorkBuddyAuthPlugin, auth)]).toEqual([status, { error: said, signIn: "kept" }])
  }
})

test("a token near its end is renewed and saved, as the loader does", async () => {
  const sets = []
  const calls = serve({
    "/v2/plugin/auth/token/refresh": () => ok({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600 }),
    "/billing/meter/get-user-resource-summary": () => ok(PAID),
  })
  const auth = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() + 1000, uid: "u2" }
  const out = await usageOf(WorkBuddyAuthPlugin, auth, { auth: { set: async (x) => sets.push(x) } })
  expect(out.windows[0].used).toBe(25)
  // the built-in's renewal took no mark off: the read keeps the sign-in
  expect(out.signIn).toBe("kept")
  expect(calls[0].headers.get("x-refresh-token")).toBe("old-refresh")
  expect(calls[1].headers.get("authorization")).toBe("Bearer new-access")
  expect(sets.length).toBe(1)
  expect(sets[0].path).toEqual({ id: "workbuddy" })
  expect(sets[0].body).toMatchObject({ access: "new-access", refresh: "new-refresh", uid: "u2" })
})

test("the desktop's sign-in is renewed in memory only", async () => {
  const dir = process.platform === "darwin" ? join(home, "Library", "Application Support", "CodeBuddyExtension")
    : process.platform === "win32" ? join(home, "AppData", "Local", "CodeBuddyExtension") : join(home, ".local", "share", "CodeBuddyExtension")
  mkdirSync(join(dir, "Data", "Public", "auth"), { recursive: true })
  const file = join(dir, "Data", "Public", "auth", "workbuddy-desktop.info")
  const info = JSON.stringify({ auth: { accessToken: "desk-old", refreshToken: "desk-refresh", expiresAt: Date.now() + 1000, domain: "www.codebuddy.cn" },
    account: { uid: "u1", nickname: "旅行者" } })
  writeFileSync(file, info)
  const sets = []
  const calls = serve({
    "/v2/plugin/auth/token/refresh": () => ok({ accessToken: "desk-new", expiresIn: 3600 }),
    "/billing/meter/get-user-resource-summary": () => ok(PAID),
  })
  const auth = { type: "oauth", access: "", refresh: "", expires: 0, source: "desktop", uid: "u1" }
  const client = { auth: { set: async (x) => sets.push(x) } }
  expect(await usageOf(WorkBuddyAuthPlugin, auth, client)).toEqual({ signIn: "kept", plan: "Pro", windows: [{ name: "Credits", used: 25, display: "2500 / 10000", amount: 2500, limit: 10000, unit: "credits" }] })
  expect(calls[1].headers.get("authorization")).toBe("Bearer desk-new")
  expect(calls[1].headers.get("x-domain")).toBe("www.codebuddy.cn")
  expect(sets).toEqual([]) // never saved,
  expect(readFileSync(file, "utf8")).toBe(info) // nor written where the app keeps it
  // and held: the next ask doesn't renew again
  await usageOf(WorkBuddyAuthPlugin, auth, client)
  expect(calls.filter((c) => c.url.pathname.endsWith("/refresh")).length).toBe(1)
})

test("a desktop sign-in with the app signed out says why it failed", async () => {
  const p = await WorkBuddyAIAuthPlugin({ client: {} })
  const m = p.auth.methods.find((x) => x.label.endsWith("desktop's sign-in"))
  const r = await (await m.authorize()).callback()
  expect(r).toEqual({ type: "failed", error: "WorkBuddy AI desktop isn't signed in" })
})

// plugins#18 (seavenlin, WorkBuddy desktop 5.8.1): a sign-in the app seals
// at rest read as "isn't signed in", while the app was signed in
test("a desktop sign-in the app keeps encrypted says so, and that the browser sign-in is the way", async () => {
  const dir = process.platform === "darwin" ? join(home, "Library", "Application Support", "CodeBuddyExtension")
    : process.platform === "win32" ? join(home, "AppData", "Local", "CodeBuddyExtension") : join(home, ".local", "share", "CodeBuddyExtension")
  mkdirSync(join(dir, "Data", "Public", "auth"), { recursive: true })
  const file = join(dir, "Data", "Public", "auth", "workbuddy-desktop-ai.info")
  const sealed = { $wbEncrypted: 1, envelope: "AAAA" }
  const info = JSON.stringify({ auth: { accessToken: sealed, refreshToken: sealed, expiresAt: Date.now() + 3600_000 }, account: { uid: "u9", nickname: "x" } })
  writeFileSync(file, info)
  const want = 'WorkBuddy AI desktop keeps its sign-in encrypted (WorkBuddy 5.6 and later), which magpie can\'t read; sign in with "WorkBuddy AI account (browser)" instead'
  const p = await WorkBuddyAIAuthPlugin({ client: {} })
  const m = p.auth.methods.find((x) => x.label.endsWith("desktop's sign-in"))
  expect(await (await m.authorize()).callback()).toEqual({ type: "failed", error: want })
  // one signed in before the app sealed it: its usage and chats say the same
  const auth = { type: "oauth", access: "", refresh: "", expires: 0, source: "desktop", uid: "u9" }
  expect((await usageOf(WorkBuddyAIAuthPlugin, auth, { auth: { set: async () => {} } })).error).toBe(want)
  const opts = await p.auth.loader(async () => auth)
  await expect(chatFetch(opts)(opts.baseURL + "/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(want)
  expect(readFileSync(file, "utf8")).toBe(info)
  rmSync(file)
})

// Each model carries the credits WorkBuddy's picker shows by it, as
// magpie's built-in reads them (internal/provider/workbuddy_free_test.go,
// TestWBCreditsRate): x0.03 is 0.03, X1.00 is 1; x0.00 is free and no
// rate, and one it can't read (or an infinite one) is neither.
test("each model's rate is its credits", async () => {
  for (const plugin of [WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin]) {
    const calls = serve({ "/v3/config": () => ok({
      agents: [{ name: "cli", models: ["deepseek-v4.1-flash", "deepseek-v4.1-flash-sg", "gpt-5.5", "kimi-k3", "hy3", "odd", "inf"] }],
      models: [
        { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", credits: "x0.00" },
        { id: "deepseek-v4.1-flash-sg", name: "Deepseek-V4.1-Flash SG", credits: "x0.03" },
        { id: "gpt-5.5", credits: "X1.00" },
        { id: "kimi-k3", credits: 1.5 },
        { id: "hy3" },
        { id: "odd", credits: "lots" },
        { id: "inf", credits: "xInfinity" },
      ],
    }) })
    const hooks = await plugin({ client: {} })
    const auth = { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u", domain: "" }
    const ms = await hooks.provider.models({ id: hooks.auth.provider, models: {} }, { auth })
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v3/config"])
    expect(Object.fromEntries(Object.entries(ms).map(([k, m]: [string, WireRecord]) => [k, [m.rate, m.free]]))).toEqual({
      "deepseek-v4.1-flash": [0, true],
      "deepseek-v4.1-flash-sg": [0.03, false],
      "gpt-5.5": [1, false],
      "kimi-k3": [1.5, false],
      hy3: [0, false],
      odd: [0, false],
      inf: [0, false],
    })
  }
  const { creditsOf } = _internal
  expect(["x0.03", " X1.00 ", 1.5, "0"].map(creditsOf)).toEqual([0.03, 1, 1.5, 0])
  for (const c of ["", null, undefined, "free", "x-1", "Infinity"]) expect(creditsOf(c)).toBeUndefined()
})

// WorkBuddy AI's GLM models take no images, though its config says every
// model does: on 2026-10-13 a real account's image sent to glm-5.3-flash,
// glm-5.3 and glm-5.2 came back as "[System reminder: the current model
// does not support images. Content filtered. ...]" (Yirasumi on Discord).
// Its other models read them, and WorkBuddy (China)'s GLM does too, so
// only WorkBuddy AI's GLM models lose images.
test("WorkBuddy AI's GLM models are text-only, its others and China's GLM keep images (Yirasumi on Discord)", async () => {
  const ids = ["glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-6", "deepseek-v4.1-flash", "kimi-k3", "gemini-3.5-flash", "gpt-5.5", "hy3"]
  const cfg = () => ok({
    agents: [{ name: "cli", models: [...ids, "said-nothing"] }],
    models: [...ids.map((id) => ({ id, name: id, supportsImages: id !== "hy3" })), { id: "said-nothing" }],
  })
  const auth = { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u", domain: "" }
  const images = async (plugin) => {
    serve({ "/v3/config": cfg })
    const hooks = await plugin({ client: {} })
    const ms = await hooks.provider.models({ id: hooks.auth.provider, models: {} }, { auth })
    return Object.fromEntries(Object.entries(ms).map(([k, m]: [string, WireRecord]) => [k, [m.capabilities.input.image, m.capabilities.attachment]]))
  }
  expect(await images(WorkBuddyAIAuthPlugin)).toEqual({
    "glm-5.3-flash": [false, false], "glm-5.3": [false, false], "glm-5.2": [false, false], "glm-6": [false, false],
    "deepseek-v4.1-flash": [true, true], "kimi-k3": [true, true], "gemini-3.5-flash": [true, true], "gpt-5.5": [true, true],
    hy3: [false, false], "said-nothing": [false, false],
  })
  expect(await images(WorkBuddyAuthPlugin)).toEqual({
    "glm-5.3-flash": [true, true], "glm-5.3": [true, true], "glm-5.2": [true, true], "glm-6": [true, true],
    "deepseek-v4.1-flash": [true, true], "kimi-k3": [true, true], "gemini-3.5-flash": [true, true], "gpt-5.5": [true, true],
    hy3: [false, false], "said-nothing": [false, false],
  })
  const { textOnly, SITES } = _internal
  // the family, by its id's start: not a model whose id only has glm in it
  expect(textOnly(SITES["workbuddy-ai"], "my-glm-5")).toBe(false)
  expect(textOnly(SITES.workbuddy, "glm-5.3-flash")).toBe(false)
})

// the detail lists as www.workbuddy.ai sent them for a Pro account on
// 2026-10-11 (ids left out): the Bonus Pack's 232.4 credits left end on
// 10-13, before Pro's on 10-29; the Free Plan's daily slice (CapacityType
// 4) isn't in the summary and ends at the same midnight on every account
const BONUS = "TCACA_code_006_DbXS0lrypC"
const AI_SUMMARY = { IsPaidUser: true, Packages: [
  { PackageCode: "TCACA_code_002_AkiJS3ZHF5", CycleTotalCapacity: "1000", CycleRemainCapacity: "1000", CycleUsedCapacity: "0" },
  { PackageCode: BONUS, CycleTotalCapacity: "250", CycleRemainCapacity: "232.4", CycleUsedCapacity: "17.6" },
  { PackageCode: "TCACA_code_037_WxOD3MpI2o", CycleTotalCapacity: "1000", CycleRemainCapacity: "1000", CycleUsedCapacity: "0" },
] }
const AI_PAID = { TotalCount: 1, Accounts: [
  { PackageCode: "TCACA_code_002_AkiJS3ZHF5", PackageName: "Pro Monthly", CapacityType: 2, CycleCapacityRemainPrecise: "1000", CycleStartTime: "2026-09-29 00:40:52", CycleEndTime: "2026-10-29 00:40:52", DeductionEndTime: 1793205652000, ExpiredTime: "" },
] }
const AI_FREE = { TotalCount: 3, Accounts: [
  { PackageCode: BONUS, PackageName: "Bonus Pack", CapacityType: 1, CycleCapacityRemainPrecise: "232.4", CycleStartTime: "2026-09-29 00:39:27", CycleEndTime: "2026-10-13 00:39:27", DeductionEndTime: 1791823167000, ExpiredTime: "" },
  { PackageCode: "TCACA_code_037_WxOD3MpI2o", PackageName: "Plan Bonus", CapacityType: 2, CycleCapacityRemainPrecise: "1000", CycleStartTime: "2026-09-29 00:40:52", CycleEndTime: "2026-10-29 00:40:52", DeductionEndTime: 1793205652000, ExpiredTime: "" },
  { PackageCode: "TCACA_code_035_ArVxJcGDsm", PackageName: "Free Plan", CapacityType: 4, CycleCapacityRemainPrecise: "100", CycleStartTime: "2026-10-01 00:00:00", CycleEndTime: "2026-10-31 23:59:59", DeductionEndTime: 2050936768000, ExpiredTime: "" },
] }

test("the credits that run out soonest, for routing to spend first (cdredfox on X)", async () => {
  // the same lists ten years on, so the test still reads them as to come
  const YEARS = 10, later10 = (d) => ({ ...d, Accounts: d.Accounts.map((p) => ({ ...p, DeductionEndTime: p.DeductionEndTime + Date.UTC(2036, 9, 1) - Date.UTC(2026, 9, 1),
    CycleEndTime: String(Number(p.CycleEndTime.slice(0, 4)) + YEARS) + p.CycleEndTime.slice(4) })) })
  const bodies: WireRecord = {}
  serve({
    "/billing/meter/get-user-resource-summary": () => ok(AI_SUMMARY),
    "/billing/meter/get-user-resource-paid-packages": (init) => ((bodies.paid = parse(init.body)), ok(later10(AI_PAID))),
    "/billing/meter/get-user-resource-free-packages": (init) => ((bodies.free = parse(init.body)), ok(later10(AI_FREE))),
  })
  const auth = { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u" }
  const u = await usageOf(WorkBuddyAIAuthPlugin, auth)
  const w = u.windows.find((x) => x.name === "Credits")
  expect(w.runsOutAt).toBe("2036-10-12T16:39:27.000Z")
  expect(w.runsOut).toBe(232.4)
  // the lists are asked for as WorkBuddy's client asks: without the codes
  // the API answers 10001 "PackageCodes required"
  expect(bodies.paid).toMatchObject({ PageNumber: 1, PageSize: 200, Status: [0, 3], NeedRenewInfo: true })
  expect(bodies.paid.PackageCodes).toContain("TCACA_code_002_AkiJS3ZHF5")
  expect(bodies.free.PackageCodes).toContain(BONUS)
  expect(bodies.free.SlicePeriodStartTime).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/)
})

test("runsOutOf: soonest end of credits left, by the summary's packages, never the daily slice", () => {
  const now = Date.parse("2026-10-11T12:00:00Z")
  expect(_internal.runsOutOf(AI_SUMMARY, [...AI_PAID.Accounts, ...AI_FREE.Accounts], now)).toEqual({ runsOutAt: "2026-10-12T16:39:27.000Z", runsOut: 232.4 })
  // the Bonus Pack spent: Pro and Plan Bonus end together, both count
  const spent = AI_FREE.Accounts.map((p) => (p.PackageCode === BONUS ? { ...p, CycleCapacityRemainPrecise: "0" } : p))
  expect(_internal.runsOutOf(AI_SUMMARY, [...AI_PAID.Accounts, ...spent], now)).toEqual({ runsOutAt: "2026-10-28T16:40:52.000Z", runsOut: 2000 })
  // no DeductionEndTime: the cycle's end is read as UTC+8
  const plain = [{ ...AI_FREE.Accounts[0], DeductionEndTime: 0 }]
  expect(_internal.runsOutOf(AI_SUMMARY, plain, now)).toEqual({ runsOutAt: "2026-10-12T16:39:27.000Z", runsOut: 232.4 })
  // only the daily slice, or a package already over: unknown
  expect(_internal.runsOutOf(AI_SUMMARY, [AI_FREE.Accounts[2]], now)).toBeNull()
  expect(_internal.runsOutOf(AI_SUMMARY, AI_FREE.Accounts, Date.parse("2026-11-01T00:00:00Z"))).toBeNull()
})

test("a detail list that can't be read leaves the card as it was", async () => {
  serve({
    "/billing/meter/get-user-resource-summary": () => ok(AI_SUMMARY),
    "/billing/meter/get-user-resource-paid-packages": () => new Response(JSON.stringify({ code: 10001, msg: "PackageCodes required" }), { status: 400 }),
  })
  const u = await usageOf(WorkBuddyAIAuthPlugin, { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u" })
  expect(u.error).toBeUndefined()
  expect(u.windows[0]).toEqual({ name: "Credits", used: 100 * 17.6 / 2250, display: "17.6 / 2250", amount: 17.6, limit: 2250, unit: "credits" })
})

// magpie #1904 (CnsMaple): an enterprise account's resource summary has no
// packages, and its credits are the enterprise meter's, which WorkBuddy's
// own usage page reads. The two answers below are the reporter's, byte for
// byte, from one token at one moment.
const ENT_SUMMARY = `{
  "code": 0,
  "msg": "OK",
  "data": {
    "Packages": [],
    "SubscriptionPackageCode": "",
    "SubscriptionPackageName": "",
    "IsPaidUser": false,
    "IsProtectedPriceUser": false
  }
}`
const ENT_USAGE = `{
  "code": 0,
  "msg": "OK",
  "data": {
    "credit": 196.13,
    "cycleStartTime": "2026-10-08 00:00:00",
    "cycleEndTime": "2026-11-08 23:59:59",
    "limitNum": 2000,
    "cycleResetTime": "2026-11-09 00:00:00"
  }
}`
// and a personal account's answer to the enterprise meter, from a real
// WorkBuddy AI Pro account on 2026-10-13
const PERSONAL_ENT = `{"code":10001,"msg":"uid or enterpriseID is empty","requestId":"36dd0f64-cb93-41e1-a964-9e3c87fea235"}`

test("an enterprise account's credits are the enterprise meter's, as WorkBuddy's usage page reads them (magpie #1904)", async () => {
  const calls = serve({
    "/billing/meter/get-user-resource-summary": () => new Response(ENT_SUMMARY),
    "/billing/meter/get-enterprise-user-usage": () => new Response(ENT_USAGE),
  })
  const auth = { type: "oauth", access: "ent-access", refresh: "r", expires: later(), uid: "u9", domain: "www.workbuddy.cn", enterpriseId: "ent-1" }
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ signIn: "kept", plan: "Enterprise", windows: [{
    name: "Credits", used: (100 * 196.13) / 2000, display: "196.13 / 2000", amount: 196.13, limit: 2000, unit: "credits",
    resetsAt: "2026-11-08T16:00:00.000Z", span: 32 * 86400 }] })
  const ent = calls.find((c) => c.url.pathname === "/billing/meter/get-enterprise-user-usage")
  expect(ent.init.method).toBe("POST")
  expect(ent.init.body).toBe("{}")
  expect(Object.fromEntries(["authorization", "x-user-id", "x-domain", "x-enterprise-id"].map((h) => [h, ent.headers.get(h)])))
    .toEqual({ authorization: "Bearer ent-access", "x-user-id": "u9", "x-domain": "www.workbuddy.cn", "x-enterprise-id": "ent-1" })
})

test("a personal account with no credits isn't given the enterprise's, and its refusal isn't the card's error", async () => {
  serve({
    "/billing/meter/get-user-resource-summary": () => new Response(ENT_SUMMARY),
    "/billing/meter/get-enterprise-user-usage": () => new Response(PERSONAL_ENT, { status: 400 }),
  })
  const auth = { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u" }
  expect(await usageOf(WorkBuddyAuthPlugin, auth)).toEqual({ signIn: "kept", plan: "Free", windows: [] })
})

test("a personal account with credits never asks the enterprise meter", async () => {
  const calls = serve({ "/billing/meter/get-user-resource-summary": () => ok(PAID) })
  const auth = { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u" }
  expect((await usageOf(WorkBuddyAuthPlugin, auth)).windows[0].display).toBe("2500 / 10000")
  expect(calls.some((c) => c.url.pathname === "/billing/meter/get-enterprise-user-usage")).toBe(false)
})

test("enterpriseUsageOf: no limit, no window; times it can't read are left out", () => {
  expect(_internal.enterpriseUsageOf({ credit: 3, limitNum: 0 })).toBe(null)
  expect(_internal.enterpriseUsageOf(null)).toBe(null)
  expect(_internal.enterpriseUsageOf({ credit: "12.5", limitNum: "100", cycleResetTime: "soon" }))
    .toEqual({ name: "Credits", used: 12.5, display: "12.5 / 100", amount: 12.5, limit: 100, unit: "credits" })
})

// A model at x0.00 draws no credits, and with the credits used up
// WorkBuddy still serves it: hheei's account at 560 / 560 was served
// deepseek-v4.1-flash (magpie-community/plugins#138). The credits window
// leaves those models out (notModels), so magpie doesn't put the account
// last for them. One free only at night (a daily promotion) still counts.
const FREE_CFG = () => ok({
  agents: [{ name: "cli", models: ["deepseek-v4.1-flash", "deepseek-v4.1-flash-sg", "gpt-5.5", "hy4"] }],
  models: [
    { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", credits: "x0.00" },
    { id: "deepseek-v4.1-flash-sg", name: "Deepseek-V4.1-Flash", credits: "x0.03" },
    { id: "gpt-5.5", credits: "x1.00" },
    { id: "hy4", credits: "x0.50" },
  ],
  modelPromotions: [{ kind: "discount", modelIds: ["hy4"], discount: { discountedCredits: "0.00x" }, schedule: { daily: [{ start: "23:00", end: "08:00" }] } }],
})
const SPENT = { IsPaidUser: false, Packages: [{ CycleTotalCapacity: "560", CycleUsedCapacity: "560" }] }

test("credits used up don't count the free models (plugins#138, hheei)", async () => {
  for (const plugin of [WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin]) {
    serve({ "/billing/meter/get-user-resource-summary": () => ok(SPENT), "/v3/config": FREE_CFG })
    const auth = { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u", domain: "" }
    expect(await usageOf(plugin, auth)).toEqual({ signIn: "kept", plan: "Free", windows: [{
      name: "Credits", used: 100, display: "560 / 560", amount: 560, limit: 560, unit: "credits", notModels: ["deepseek-v4.1-flash"] }] })
  }
})

test("an enterprise account's credits don't count the free models either", async () => {
  serve({
    "/billing/meter/get-user-resource-summary": () => new Response(ENT_SUMMARY),
    "/billing/meter/get-enterprise-user-usage": () => new Response(ENT_USAGE),
    "/v3/config": FREE_CFG,
  })
  const auth = { type: "oauth", access: "ent-access", refresh: "r", expires: later(), uid: "u9", domain: "www.workbuddy.cn", enterpriseId: "ent-1" }
  expect((await usageOf(WorkBuddyAuthPlugin, auth)).windows[0].notModels).toEqual(["deepseek-v4.1-flash"])
})

test("a model list that can't be read leaves the credits counting every model", async () => {
  serve({ "/billing/meter/get-user-resource-summary": () => ok(SPENT), "/v3/config": () => new Response("busy", { status: 503 }) })
  const auth = { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u", domain: "" }
  const w = (await usageOf(WorkBuddyAuthPlugin, auth)).windows[0]
  expect(w.used).toBe(100)
  expect(w.notModels).toBeUndefined()
})
