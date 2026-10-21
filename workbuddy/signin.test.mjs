// What a failure means for the sign-in, as magpie's built-in WorkBuddy
// account had it: WorkBuddy's own 401 was passed on and no WorkBuddy
// account was ever marked lapsed, so every refusal says X-Magpie-Sign-In:
// kept; a token that couldn't be renewed fails in wbFresh's words.
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAIAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const later = () => Date.now() + 3600_000
const ask = async (reply) => {
  globalThis.fetch = async () => reply()
  const auth = { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u" }
  const hooks = await WorkBuddyAIAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  return opts.fetch("https://www.workbuddy.ai/v2/chat/completions", { method: "POST", body: '{"messages":[]}' })
}

test("WorkBuddy's 401 goes on as it came, the account kept", async () => {
  const res = await ask(() => new Response('{"code":401,"msg":"token invalid"}', { status: 401 }))
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(await res.text()).toBe('{"code":401,"msg":"token invalid"}')
})

test("the channel refusal keeps the account too", async () => {
  const res = await ask(() => new Response('{"code":11004,"msg":"Illegal API invocation from an unapproved channel"}', { status: 403 }))
  expect(res.status).toBe(403)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
})

// nor cleared one: a reply that went through leaves the mark as it is
test("a reply that went through keeps the sign-in too", async () => {
  const res = await ask(() => new Response("data: [DONE]\n\n", { status: 200 }))
  expect(res.status).toBe(200)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  expect(await res.text()).toBe("data: [DONE]\n\n")
})

// wbFresh with no access token left: its words, on either site
const refresh = async (reply, a = {}) => {
  globalThis.fetch = async () => reply()
  const site = _internal.SITES["workbuddy-ai"]
  try {
    await _internal.fresh(site, null, { access: "", refresh: "r", expires: 1, ...a })
  } catch (e) {
    return e.message
  }
  return "no error"
}

test("a refresh WorkBuddy refused is worded as wbCall's error", async () => {
  expect(await refresh(() => new Response('{"code":11001,"msg":"refresh token expired"}', { status: 401 }))).toBe("WorkBuddy token refresh: refresh token expired")
  expect(await refresh(() => new Response('{"code":11001}', { status: 401 }))).toBe("WorkBuddy token refresh: error 11001")
  expect(await refresh(() => new Response("", { status: 401 }))).toBe("WorkBuddy token refresh: Unauthorized")
  expect(await refresh(() => new Response('{"code":11002,"msg":"bad refresh"}'))).toBe("WorkBuddy token refresh: bad refresh")
  expect(await refresh(() => new Response('{"code":0,"data":{}}'))).toBe("WorkBuddy gave no refreshed token")
})

test("nothing to refresh with is signed out, in the built-in's words", async () => {
  expect(await refresh(() => new Response(""), { refresh: "" })).toBe("this WorkBuddy account is signed out; sign in again")
})
