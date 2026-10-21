// An enterprise (team) account is asked for as the enterprise, as
// WorkBuddy's own client asks: X-Enterprise-Id and X-Tenant-Id carry the
// account's enterpriseId on every request, or WorkBuddy answers as the
// personal account and lists the personal plan's models (#75).
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const site = _internal.SITES.workbuddy
const later = () => Date.now() + 3600_000
const config = '{"code":0,"data":{"agents":[{"name":"cli","models":["m"]}],"models":[{"id":"m","name":"M"}]}}'

const seen = (into) => async (url, init) => {
  into.push({ url: String(url), headers: new Headers(init?.headers) })
  return new Response(config)
}

test("an enterprise account's model list is asked for as the enterprise (#75)", async () => {
  const got = []
  globalThis.fetch = seen(got)
  await _internal.liveModels(site, { access: "a", uid: "u", enterpriseId: "ent-1" })
  expect(got[0].url).toEndWith("/v3/config")
  expect(got[0].headers.get("X-Enterprise-Id")).toBe("ent-1")
  expect(got[0].headers.get("X-Tenant-Id")).toBe("ent-1")
})

test("a personal account's list carries no enterprise", async () => {
  const got = []
  globalThis.fetch = seen(got)
  await _internal.liveModels(site, { access: "a", uid: "u" })
  expect(got[0].headers.has("X-Enterprise-Id")).toBe(false)
  expect(got[0].headers.has("X-Tenant-Id")).toBe(false)
})

test("an enterprise account's chats carry the enterprise too", async () => {
  const got = []
  globalThis.fetch = seen(got)
  const auth = { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u", enterpriseId: "ent-1" }
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  await opts.fetch("https://copilot.tencent.com/v2/chat/completions", { method: "POST", body: '{"messages":[]}' })
  expect(got.at(-1).headers.get("X-Enterprise-Id")).toBe("ent-1")
  expect(got.at(-1).headers.get("X-Tenant-Id")).toBe("ent-1")
})

// the sign-in, with WorkBuddy's answers as its own client reads them
const signIn = async (account, accounts) => {
  const asked = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    asked.push(u.pathname)
    const data =
      u.pathname.endsWith("/auth/state") ? { state: "s", authUrl: "https://www.codebuddy.cn/login" }
      : u.pathname.endsWith("/auth/token") ? { accessToken: "a", refreshToken: "r", expiresIn: 3600 }
      : u.pathname.endsWith("/login/account") ? account
      : u.pathname.endsWith("/accounts") ? { accounts }
      : {}
    return new Response(JSON.stringify({ code: 0, data }))
  }
  const flow = await _internal.browserSignIn(site)
  return { result: await flow.callback(), asked }
}

test("signing in as an enterprise keeps the enterprise WorkBuddy named", async () => {
  const { result, asked } = await signIn({ uid: "u", nickname: "n", type: "ultimate", enterpriseId: "ent-1" }, [])
  expect(result.type).toBe("success")
  expect(result.enterpriseId).toBe("ent-1")
  expect(asked.some((p) => p.endsWith("/accounts"))).toBe(false)
})

test("an enterprise account named without its id is found in the account list", async () => {
  const { result } = await signIn({ uid: "u", nickname: "n", type: "ultimate" }, [
    { uid: "u", type: "personal", lastLogin: false },
    { uid: "u", type: "ultimate", enterpriseId: "ent-2", lastLogin: true },
    { uid: "other", type: "ultimate", enterpriseId: "ent-3", lastLogin: true },
  ])
  expect(result.enterpriseId).toBe("ent-2")
})

test("signing in as the personal account keeps no enterprise", async () => {
  const { result, asked } = await signIn({ uid: "u", nickname: "n", type: "personal" }, [
    { uid: "u", type: "ultimate", enterpriseId: "ent-2", lastLogin: true },
  ])
  expect(result.type).toBe("success")
  expect("enterpriseId" in result).toBe(false)
  expect(asked.some((p) => p.endsWith("/accounts"))).toBe(false)
})
