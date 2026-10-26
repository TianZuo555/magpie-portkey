// auth.checkin presses WorkBuddy's daily check-in (签到) through the plugin's
// fetch, as magpie's built-in does it (internal/provider/workbuddy_checkin.go):
// the event's status first, a claim only while it runs and today's isn't in,
// the event's own codes 1001/1002/1003 read as answers for the day, and a 401
// as a sign-in to make again.
import { setFetch, type Call } from "./test-helpers.ts"
import type { Account, Checkin } from "./types.ts"
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

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
// doesn't inherit offline
const offline = async () => { throw new Error("no network in tests") }
const real = globalThis.fetch
setFetch(offline)
afterAll(() => (setFetch(real)))
afterEach(() => {
  setFetch(offline)
  _internal.desktopHeld.clear()
})

const later = () => Date.now() + 3600_000
const ok = (data) => new Response(JSON.stringify({ code: 0, msg: "OK", data }))
// the event as the live API sends it on 2026-10-26, cut to what is read
const ON = { active: true, today_checked_in: false, streak_days: 7, daily_credit: 100, today_credit: 0 }
const CLAIMED = { credit: 100, streak_days: 8, is_streak_day: true, credit_delayed: false, message: "" }

function serve(routes) {
  const calls: Call[] = []
  setFetch(async (url, init) => {
    const u = new URL(String(url))
    calls.push({ url: u, init, headers: new Headers(init?.headers) })
    const r = routes[u.pathname]
    return r ? r(init) : new Response("", { status: 404 })
  })
  return calls
}
const signIn = (extra: Partial<Account> = {}): Account => ({ type: "oauth", access: "an-access", refresh: "a-refresh", expires: later(), uid: "u1", domain: "", ...extra })
const checkinOf = async (plugin, auth, client = {}) => (await plugin({ client })).auth.checkin?.(async () => auth)

const status = () => serve({ "/v2/billing/meter/checkin-activity-status": () => ok(ON), "/v2/billing/meter/daily-checkin": () => ok(CLAIMED) })

test("the plugin presses the daily check-in, as magpie's built-in does", async () => {
  const calls = status()
  expect(await checkinOf(WorkBuddyAuthPlugin, signIn())).toEqual({ outcome: "claimed", credit: 100, streak: 8, message: undefined })
  expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/billing/meter/checkin-activity-status", "/v2/billing/meter/daily-checkin"])
  for (const c of calls) {
    expect(c.init.method).toBe("POST")
    expect(c.init.body).toBe("{}")
    // what the billing API's own client sends: axios' User-Agent, and the
    // sign-in's headers, which the app's check-in carries too
    expect(Object.fromEntries(["authorization", "x-user-id", "x-domain", "x-product", "x-ide-type", "user-agent"].map((h) => [h, c.headers.get(h)])))
      .toEqual({ authorization: "Bearer an-access", "x-user-id": "u1", "x-domain": "copilot.tencent.com", "x-product": "SaaS", "x-ide-type": "WorkBuddy", "user-agent": "axios/1.16.1" })
  }
})

test("the international build checks in at its own address", async () => {
  const calls = status()
  const r = await checkinOf(WorkBuddyAIAuthPlugin, signIn({ domain: "www.workbuddy.ai" }))
  expect(r).toEqual({ outcome: "claimed", credit: 100, streak: 8, message: undefined })
  expect(calls[0].url.origin).toBe("https://www.workbuddy.ai")
})

// an answer for the day: the status alone says it, and no claim is pressed
test("today's already in: the status says so, and nothing is claimed", async () => {
  const calls = serve({ "/v2/billing/meter/checkin-activity-status": () => ok({ ...ON, today_checked_in: true, streak_days: 8, today_credit: 100 }) })
  expect(await checkinOf(WorkBuddyAuthPlugin, signIn())).toEqual({ outcome: "done", credit: 100, streak: 8 })
  expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/billing/meter/checkin-activity-status"])
})

test("no event running: inactive, not a claim", async () => {
  const calls = serve({ "/v2/billing/meter/checkin-activity-status": () => ok({ ...ON, active: false }) })
  expect(await checkinOf(WorkBuddyAuthPlugin, signIn())).toEqual({ outcome: "inactive" })
  expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/billing/meter/checkin-activity-status"])
})

// a status with none of the event in it says nothing of the day, so it is a
// failure magpie tries again, not "no event running" for the rest of it
test("a status with no event in it is a failure, not the day's answer", async () => {
  serve({ "/v2/billing/meter/checkin-activity-status": () => ok({}) })
  const r = await checkinOf(WorkBuddyAuthPlugin, signIn())
  expect(r?.outcome).toBe("failed")
  expect(r?.message).toContain("with no event in it")
})

// the event's own refusals of a claim are its answers for the day
test("a claim refused 1001, 1002 or 1003 is the event's answer for the day", async () => {
  const claim = (code, msg, status = 400) => () => new Response(JSON.stringify({ code, msg }), { status })
  for (const [code, outcome, msg] of [
    [1001, "done", "今天已签到，请明天再来"],
    [1002, "ineligible", "this account can't take part"],
    [1003, "inactive", "the event is over"],
  ]) {
    serve({ "/v2/billing/meter/checkin-activity-status": () => ok(ON), "/v2/billing/meter/daily-checkin": claim(code, msg) })
    const r = await checkinOf(WorkBuddyAuthPlugin, signIn())
    expect(r?.outcome).toBe(outcome)
    // 1003 and 1002 say why in the event's words; 1001 needs none: it is
    // "today's is in", which the label says
    if (code !== 1001) expect(r?.message).toBe(msg)
  }
})

// a code that only begins with 1001 is another error: the code is compared
// whole, as Go's switch does. WorkBuddy AI's claim answers 400 with 10001
// ("签到活动未开启或已过期"), which is not today's check-in in already
test("a code that only begins with 1001 is not today's check-in", async () => {
  serve({ "/v2/billing/meter/checkin-activity-status": () => new Response(JSON.stringify({ code: 10001, msg: "签到活动未开启或已过期" }), { status: 400 }) })
  const r = await checkinOf(WorkBuddyAIAuthPlugin, signIn())
  expect(r?.outcome).toBe("failed")
  expect(r?.message).toBe("签到活动未开启或已过期")
})

// WorkBuddy AI ships with the event off: its status says so, and nothing is
// claimed (measured 2026-10-26: active false, its claim 400 code 10001)
test("WorkBuddy AI has no event running: inactive, as magpie's built-in says", async () => {
  const calls = serve({ "/v2/billing/meter/checkin-activity-status": () => ok({ active: false, today_checked_in: false, streak_days: 0, daily_credit: 100, today_credit: 100 }) })
  expect(await checkinOf(WorkBuddyAIAuthPlugin, signIn({ domain: "www.workbuddy.ai" }))).toEqual({ outcome: "inactive" })
  expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/billing/meter/checkin-activity-status"])
})

// a claim that was in already still carries the status' streak, as magpie's
// built-in does (wbCheckin's CheckinDone)
test("a claim answered 1001 carries the streak the status gave", async () => {
  serve({
    "/v2/billing/meter/checkin-activity-status": () => ok({ ...ON, streak_days: 9 }),
    "/v2/billing/meter/daily-checkin": () => new Response(JSON.stringify({ code: 1001, msg: "今天已签到，请明天再来" }), { status: 400 }),
  })
  expect(await checkinOf(WorkBuddyAuthPlugin, signIn())).toEqual({ outcome: "done", streak: 9 })
})

// WorkBuddy's front door answers a token it refuses with a bare HTML 401:
// the card says to sign in again, not "Unauthorized"
test("a 401 on the status or the claim says to sign in again", async () => {
  const html = '<html><head><title>401 Authorization Required</title></head><body>openresty</body></html>'
  const refused = () => new Response(html, { status: 401, headers: { "content-type": "text/html", "www-authenticate": 'Bearer realm="copilot", error="invalid_token"' } })
  for (const routes of [
    { "/v2/billing/meter/checkin-activity-status": refused },
    { "/v2/billing/meter/checkin-activity-status": () => ok(ON), "/v2/billing/meter/daily-checkin": refused },
  ]) {
    serve(routes)
    const r = await checkinOf(WorkBuddyAuthPlugin, signIn())
    expect(r?.outcome).toBe("failed")
    expect(r?.message).toContain("refused this account's sign-in (401 Unauthorized); sign in to it again")
    // WorkBuddy's HTML page is not what the user is shown
    expect(r?.message).not.toContain("openresty")
  }
})

// the event's words for a failure that isn't an answer: magpie tries again.
// The reply's msg is said first, as magpie's built-in words wbCall's error
test("a failure that is no answer says why, and is tried again", async () => {
  serve({ "/v2/billing/meter/checkin-activity-status": () => new Response(JSON.stringify({ code: 0, msg: "OK" }), { status: 500 }) })
  expect(await checkinOf(WorkBuddyAuthPlugin, signIn())).toEqual({ outcome: "failed", message: "OK" })
})

// a 5xx with a message of its own says that
test("a 5xx with a message says the message", async () => {
  serve({ "/v2/billing/meter/checkin-activity-status": () => new Response(JSON.stringify({ code: 0, msg: "the event is being updated" }), { status: 503 }) })
  expect(await checkinOf(WorkBuddyAuthPlugin, signIn())).toEqual({ outcome: "failed", message: "the event is being updated" })
})

// a 5xx with no words says the HTTP status, as magpie's built-in does
test("a 5xx with no message says the status", async () => {
  serve({ "/v2/billing/meter/checkin-activity-status": () => new Response("", { status: 500 }) })
  expect(await checkinOf(WorkBuddyAuthPlugin, signIn())).toEqual({ outcome: "failed", message: "Internal Server Error" })
})

// offline: no name lookup, no connection. Bun's words for it say what
// happened, and magpie tries again sooner (its built-in reads the same words)
test("a request that never reached WorkBuddy is a failure with its reason", async () => {
  setFetch(async () => { throw new Error("Unable to connect. Is the computer able to access the URL?") })
  const r = await checkinOf(WorkBuddyAuthPlugin, signIn())
  expect(r?.outcome).toBe("failed")
  expect(r?.message).toContain("Unable to connect")
})

// an account whose access token is about to end is renewed first, and what
// that gave is saved, as magpie's built-in does before its own check-in
test("a sign-in near its end is renewed before the check-in", async () => {
  const calls = serve({
    "/v2/plugin/auth/token/refresh": () => ok({ accessToken: "a-new", refreshToken: "a-new-refresh", expiresIn: 3600 }),
    "/v2/billing/meter/checkin-activity-status": () => ok({ ...ON, today_checked_in: true, today_credit: 100, streak_days: 8 }),
  })
  const saved: unknown[] = []
  const client = { auth: { set: async (v: unknown) => { saved.push(v) } } }
  expect(await checkinOf(WorkBuddyAuthPlugin, signIn({ expires: Date.now() + 1000 }), client)).toEqual({ outcome: "done", credit: 100, streak: 8 })
  expect(calls[0].url.pathname).toBe("/v2/plugin/auth/token/refresh")
  expect(calls[1].headers.get("authorization")).toBe("Bearer a-new")
  expect((saved[0] as any)?.body?.access).toBe("a-new")
})

// a desktop sign-in with no readable file at all says so, before any request
test("a desktop sign-in the app doesn't keep says to sign in to the app", async () => {
  const calls = serve({})
  const r = await checkinOf(WorkBuddyAuthPlugin, signIn({ source: "desktop" }))
  expect(r).toEqual({ outcome: "failed", message: "WorkBuddy desktop isn't signed in" })
  expect(calls).toEqual([])
})

// a desktop sign-in has no refresh token to spend on a 401 here, and the
// app's file is read again instead: the answer says to sign in again
test("a desktop sign-in refused is still the user's to make again", async () => {
  serve({ "/v2/billing/meter/checkin-activity-status": () => new Response("", { status: 401 }) })
  const r = await _internal.checkinOf(_internal.SITES.workbuddy, { ...signIn({ source: "desktop" }), access: "a-desktop" })
  expect(r).toEqual({ outcome: "failed", message: "WorkBuddy refused this account's sign-in (401 Unauthorized); sign in to it again" })
})

// the hook's own failures are answers too: a hook that throws is a failure
// to magpie, so this one catches and says why
test("a sign-in that can't be read is a failure, not a thrown hook", async () => {
  serve({})
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const r = await hooks.auth.checkin!(() => Promise.reject(new Error("plugin-auth.json is unreadable")))
  expect(r).toEqual({ outcome: "failed", message: "plugin-auth.json is unreadable" })
})

// nothing signed in: magpie asks nothing, and says so
test("an account that isn't signed in is a failure, and asks WorkBuddy nothing", async () => {
  const calls = serve({})
  expect(await checkinOf(WorkBuddyAuthPlugin, null as unknown as Account)).toEqual({ outcome: "failed", message: "WorkBuddy isn't signed in" })
  expect(calls).toEqual([])
})

// magpie lists a provider as checking in by the hook's presence alone, and
// a plugin's hook must answer one of the outcomes magpie knows
test("both builds give the hook, with the outcomes magpie takes", async () => {
  for (const plugin of [WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin]) {
    const hooks = await plugin({ client: {} })
    expect(typeof hooks.auth.checkin).toBe("function")
    serve({ "/v2/billing/meter/checkin-activity-status": () => ok({ ...ON, today_checked_in: true, today_credit: 100 }) })
    const r = await hooks.auth.checkin!(async () => signIn())
    expect(["claimed", "done", "ineligible", "inactive", "captcha", "failed"]).toContain(r.outcome as string)
  }
})
