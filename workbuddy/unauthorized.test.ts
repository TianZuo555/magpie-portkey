// A chat WorkBuddy answers 401 is renewed once and sent once more, before
// the token's time: a browser sign-in's token lasts as long as its refresh
// token (about 340 days), and one WorkBuddy refused before then was
// refused on every request for months, renewed by nothing, its 401 passed
// on as WorkBuddy's HTML page (wenchen855443 on X: "with WorkBuddy as the
// provider, requests return a 401"). What WorkBuddy answers is as measured
// on www.workbuddy.ai on 2026-10-23: a token it doesn't take gets 401 with
// WWW-Authenticate error="invalid_token"; a refresh token it doesn't take
// gets HTTP 401 {"code":12153, "msg":"...invalid_grant..."}.
import { test, expect, afterAll, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { setFetch, chatFetch } from "./test-helpers.ts"
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } from "./index.ts"

// the loader tests sign in: no real sign-in may be read
if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")

const offline = async () => {
  throw new Error("no network in tests")
}
const real = globalThis.fetch
setFetch(offline)
afterAll(() => setFetch(real as unknown as typeof offline))
afterEach(() => {
  setFetch(offline)
  _internal.renewing.clear()
  _internal.renewed.clear()
  _internal.desktopHeld.clear()
})

const CHAT = "https://www.workbuddy.ai/v2/chat/completions"
const REFRESH = "/v2/plugin/auth/token/refresh"
const SUMMARY = "/billing/meter/get-user-resource-summary"
const later = () => Date.now() + 340 * 86400_000
const ok = (data) => new Response(JSON.stringify({ code: 0, msg: "OK", data }))
const PAGE = "<html><head><title>401 Authorization Required</title></head><body><center><h1>401 Authorization Required</h1></center></body></html>"
// WorkBuddy's front door refusing a token, as it does
const refusedToken = () =>
  new Response(PAGE, { status: 401, headers: { "content-type": "text/html; charset=utf-8", "www-authenticate": 'Bearer realm="copilot", error="invalid_token", error_description="invalid token"' } })
// a 401 that says nothing of the token (as some of WorkBuddy's paths answer an accepted one)
const bare401 = () => new Response(PAGE, { status: 401, headers: { "content-type": "text/html" } })
const refreshRefused = () =>
  new Response(JSON.stringify({ code: 12153, msg: "12153:refresh token failed:400 Bad Request: invalid_grant: Invalid refresh token" }), { status: 401 })
const RENEWED = { accessToken: "new", refreshToken: "r2", expiresIn: 340 * 86400, refreshExpiresIn: 340 * 86400 }
const STREAM = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'

// serve answers each path with routes[path](headers, body); a chat is
// served while its token is in good, else refused.
function serve({ good = ["new"], refresh = () => ok(RENEWED), chat, meter }: { good?: string[]; refresh?: (headers: Headers) => Response; chat?: (token: string) => Response; meter?: (token: string) => Response } = {}) {
  const calls = []
  setFetch(async (url, init) => {
    const u = new URL(String(url instanceof Request ? url.url : url))
    const headers = new Headers(init?.headers)
    calls.push({ path: u.pathname, headers, body: init?.body })
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "")
    if (u.pathname === REFRESH) return refresh(headers)
    if (u.pathname === SUMMARY) return meter ? meter(token) : good.includes(token) ? ok({ IsPaidUser: false, Packages: [] }) : refusedToken()
    if (chat) return chat(token)
    return good.includes(token) ? new Response(STREAM, { headers: { "content-type": "text/event-stream" } }) : refusedToken()
  })
  return calls
}
const of = (calls, path) => calls.filter((c) => c.path === path)

// ask is one chat through the loader of a browser sign-in stored as auth;
// stored() is what getAuth reads each time (another process may save)
async function ask(auth: any, { plugin = WorkBuddyAIAuthPlugin, sets = [] as any[], stored }: { plugin?: any; sets?: any[]; stored?: () => Promise<any> } = {}) {
  const hooks = await plugin({ client: { auth: { set: async (x) => sets.push(x) } } })
  const read = stored ?? (async () => auth)
  const opts = await hooks.auth.loader(read)
  const body = JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "Say ok." }] })
  return chatFetch(opts)(CHAT, { method: "POST", body })
}
const signedIn = (over = {}) => ({ type: "oauth", access: "old", refresh: "r1", expires: later(), refreshExpiresAt: later(), uid: "u1", domain: "www.workbuddy.ai", ...over })

test("a 401 before the token's time is renewed, saved and sent once more, which takes a mark off", async () => {
  const calls = serve()
  const sets = []
  const res = await ask(signedIn(), { sets })
  expect(res.status).toBe(200)
  expect(await res.text()).toBe(STREAM)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
  const chats = of(calls, "/v2/chat/completions")
  expect(chats.map((c) => c.headers.get("authorization"))).toEqual(["Bearer old", "Bearer new"])
  expect(Buffer.from(chats[1].body as Uint8Array).equals(chats[0].body as Uint8Array)).toBe(true) // the same request, again
  const r = of(calls, REFRESH)
  expect(r.length).toBe(1)
  expect(r[0].headers.get("x-refresh-token")).toBe("r1")
  expect(sets.length).toBe(1)
  expect(sets[0]).toMatchObject({ path: { id: "workbuddy-ai" }, body: { access: "new", refresh: "r2", uid: "u1" } })
})

test("a refresh WorkBuddy turns away too ends in signing in again, the account marked", async () => {
  const calls = serve({ refresh: refreshRefused })
  const res = await ask(signedIn())
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  const { error } = await res.json()
  expect(error.type).toBe("authentication_error")
  expect(error.message).toBe(
    "WorkBuddy AI refused this account's sign-in (401); it refused the refresh token too " +
      "(12153:refresh token failed:400 Bad Request: invalid_grant: Invalid refresh token). " +
      "Sign in to it again in magpie: Providers → WorkBuddy AI → this account's Sign in again.",
  )
  expect(of(calls, "/v2/chat/completions").length).toBe(1)
  expect(of(calls, REFRESH).length).toBe(1)
})

test("a refresh that fails for another reason says so, the account kept", async () => {
  serve({ refresh: () => new Response("busy", { status: 502 }) })
  const res = await ask(signedIn())
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect((await res.json()).error.message).toContain("renewing it failed: Bad Gateway")
})

test("a renewed token refused too is not renewed or sent again", async () => {
  const calls = serve({ good: [] })
  const res = await ask(signedIn())
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await res.json()).error.message).toContain("it refused the token renewed for it too")
  expect(of(calls, "/v2/chat/completions").map((c) => c.headers.get("authorization"))).toEqual(["Bearer old", "Bearer new"])
  expect(of(calls, REFRESH).length).toBe(1)
})

test("a 401 with no refresh token is said, and marked only when the token itself was refused", async () => {
  let calls = serve()
  let res = await ask(signedIn({ refresh: "", refreshExpiresAt: 0 }))
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await res.json()).error.message).toContain("there is no refresh token to renew it with. Sign in to it again in magpie")
  expect(of(calls, REFRESH).length).toBe(0)
  expect(of(calls, "/v2/chat/completions").length).toBe(1)

  // a refresh token past its end is as none
  calls = serve()
  res = await ask(signedIn({ refreshExpiresAt: Date.now() - 1000 }))
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await res.json()).error.message).toContain("its refresh token has ended")
  expect(of(calls, REFRESH).length).toBe(0)

  // a 401 that doesn't say the token was refused leaves the account as it is
  serve({ chat: bare401 })
  res = await ask(signedIn({ refresh: "" }))
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
})

test("a token another process saved since is taken, not renewed again", async () => {
  // another process renews and saves while this request is out
  let saved = false
  const calls = serve({ good: ["theirs"], chat: (t) => (t === "theirs" ? new Response(STREAM) : ((saved = true), refusedToken())) })
  const stored = async () => (saved ? signedIn({ access: "theirs", refresh: "r9" }) : signedIn())
  const res = await ask(null, { stored })
  expect(res.status).toBe(200)
  expect(of(calls, REFRESH).length).toBe(0)
  expect(of(calls, "/v2/chat/completions").map((c) => c.headers.get("authorization"))).toEqual(["Bearer old", "Bearer theirs"])
})

test("a refresh token another process spent while this one renewed: the one it saved is taken", async () => {
  let spent = false
  const calls = serve({ good: ["theirs"], refresh: () => ((spent = true), refreshRefused()) })
  const stored = async () => (spent ? signedIn({ access: "theirs", refresh: "r9" }) : signedIn())
  const res = await ask(null, { stored })
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
  expect(of(calls, "/v2/chat/completions").map((c) => c.headers.get("authorization"))).toEqual(["Bearer old", "Bearer theirs"])
})

test("a 401 on a later try of the same request (after a 400 the request is sent again for) isn't renewed twice", async () => {
  // the system prompt refused as an unapproved channel, then the renewed token refused
  let chats = 0
  const calls = serve({
    chat: (token) => {
      chats++
      if (chats === 1) return refusedToken()
      if (chats === 2) return new Response(JSON.stringify({ code: 11004, msg: "Illegal API invocation from an unapproved channel" }), { status: 400 })
      return refusedToken()
    },
  })
  const hooks = await WorkBuddyAIAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  const body = JSON.stringify({ model: "m", messages: [{ role: "system", content: "You are X." }, { role: "user", content: "hi" }] })
  const res = await chatFetch(opts)(CHAT, { method: "POST", body })
  expect(res.status).toBe(401)
  expect((await res.json()).error.message).toContain("it refused the token renewed for it too")
  expect(of(calls, REFRESH).length).toBe(1)
  expect(chats).toBe(3)
})

function desktopFile(name, info) {
  const dir = process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "CodeBuddyExtension")
    : process.platform === "win32" ? join(homedir(), "AppData", "Local", "CodeBuddyExtension") : join(homedir(), ".local", "share", "CodeBuddyExtension")
  mkdirSync(join(dir, "Data", "Public", "auth"), { recursive: true })
  const file = join(dir, "Data", "Public", "auth", name)
  writeFileSync(file, JSON.stringify(info))
  return file
}
const desk = (access) => ({ auth: { accessToken: access, refreshToken: "desk-refresh", expiresAt: Date.now() + 3600_000, domain: "www.workbuddy.ai" }, account: { uid: "d1", nickname: "D" } })
const DESKTOP = { type: "oauth", access: "", refresh: "", expires: 0, source: "desktop", uid: "d1" }

test("a desktop sign-in refused reads the app's file again: its new token is taken, its refresh token never spent", async () => {
  const file = desktopFile("workbuddy-desktop-ai.info", desk("desk-old"))
  try {
    // what was renewed here before is the one refused
    _internal.desktopHeld.set("workbuddy-ai|d1", { access: "held", refresh: "x", expires: Date.now() + 7200_000, uid: "d1", source: "desktop" })
    // the app signed in again meanwhile
    writeFileSync(file, JSON.stringify(desk("desk-new")))
    const calls = serve({ good: ["desk-new"] })
    const res = await ask(DESKTOP)
    expect(res.status).toBe(200)
    expect(of(calls, "/v2/chat/completions").map((c) => c.headers.get("authorization"))).toEqual(["Bearer held", "Bearer desk-new"])
    expect(of(calls, REFRESH).length).toBe(0)
    expect(_internal.desktopHeld.get("workbuddy-ai|d1").access).toBe("desk-new")
  } finally {
    rmSync(file, { force: true })
  }
})

test("a desktop sign-in whose own token is refused says to sign in to the app again, never marked", async () => {
  const file = desktopFile("workbuddy-desktop-ai.info", desk("desk-old"))
  try {
    const calls = serve({ good: [] })
    const res = await ask(DESKTOP)
    expect(res.status).toBe(401)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
    expect((await res.json()).error.message).toContain("Sign in to WorkBuddy AI desktop again")
    expect(of(calls, REFRESH).length).toBe(0)
    expect(of(calls, "/v2/chat/completions").length).toBe(1)
  } finally {
    rmSync(file, { force: true })
  }
})

test("usage meets a 401 the same way: renewed once and read again", async () => {
  const calls = serve({ meter: (t) => (t === "new" ? ok({ IsPaidUser: true, Packages: [{ CycleTotalCapacity: "100", CycleUsedCapacity: "10" }] }) : refusedToken()) })
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const out = await hooks.auth.usage(async () => signedIn())
  expect(out).toMatchObject({ plan: "Pro", signIn: "renewed" })
  expect(out.windows[0].used).toBe(10)
  expect(of(calls, REFRESH).length).toBe(1)
})

test("usage whose refresh is turned away says to sign in again, the account marked", async () => {
  serve({ refresh: refreshRefused })
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const out = await hooks.auth.usage(async () => signedIn())
  expect(out.signIn).toBe("expired")
  expect(out.error).toContain("WorkBuddy refused this account's sign-in (401); it refused the refresh token too")
})
