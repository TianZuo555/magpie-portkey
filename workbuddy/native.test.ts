// WorkBuddy's China build serves the Claude models on Anthropic's Messages
// API at <endpoint>/v1/messages, beside chat completions at <endpoint>/v2.
// On 2026-10-24, with a real account, /v3/config's cli agent models were
// each asked on /v1/messages: claude-opus-5.5, claude-sonnet-5.5,
// claude-opus-5 and claude-opus-4.8-1m answered in Anthropic's stream;
// glm-5.3, deepseek-v4.1-flash, gpt-5.5 and kimi-k3-1 did not. WorkBuddy AI
// (www.workbuddy.ai) has no such route: /v1/messages is "404 Route Not Found"
// there for every model.
//
// The point of the route is effort: a chat carries reasoning_effort and
// WorkBuddy's chat endpoint answers at about the same length whatever it is
// (median output tokens over 4 runs: low 3884, max 5144, a nonsense value
// 5715), while Messages carries output_config.effort and max is honored
// there (median 30850 at max against 5748 at low, 4 runs each).
import { afterAll, afterEach, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
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
})

const CN = () => _internal.SITES.workbuddy
const AI = () => _internal.SITES["workbuddy-ai"]

test("the China build serves the Claude models on Messages, the rest on chat", () => {
  for (const m of ["claude-opus-5.5", "claude-sonnet-5.5", "claude-opus-5", "claude-opus-4.8-1m"])
    expect(_internal.nativeOf(CN(), m)).toBe(true)
  for (const m of ["glm-5.3", "glm-5.3-flash", "deepseek-v4.1-flash", "gpt-5.6-sol", "kimi-k3-1", "hy3", "minimax-m3"])
    expect(_internal.nativeOf(CN(), m)).toBe(false)
})

test("WorkBuddy AI serves nothing on Messages, a Claude model neither", () => {
  // its /v1/messages is a 404 route: a Claude model it lists one day goes to
  // chat, as on 0.1.31, not to a 404
  for (const m of ["claude-opus-5.5", "claude-sonnet-5.5", "glm-5.3", "gpt-5.5"])
    expect(_internal.nativeOf(AI(), m)).toBe(false)
  const m = _internal.modelOf(AI(), { id: "workbuddy-ai", models: {} }, { id: "claude-opus-5.5", name: "Claude-Opus-5.5" })
  expect(m.api.npm).toBe("@ai-sdk/openai-compatible")
  expect(m.api.url).toBe("https://www.workbuddy.ai/v2")
})

test("a listed model's api is Messages for a Claude model on the China build, chat otherwise", () => {
  const claude = _internal.modelOf(CN(), { id: "workbuddy", models: {} }, { id: "claude-opus-5.5", name: "Claude-Opus-5.5", context: 1000000 })
  expect(claude.api.npm).toBe("@ai-sdk/anthropic")
  expect(claude.api.url).toBe("https://copilot.tencent.com/v1")
  const glm = _internal.modelOf(CN(), { id: "workbuddy", models: {} }, { id: "glm-5.3", name: "GLM-5.3", context: 1000000 })
  expect(glm.api.npm).toBe("@ai-sdk/openai-compatible")
  expect(glm.api.url).toBe("https://copilot.tencent.com/v2")
})

// hostResolves is how OpenCode, and magpie's host (internal/plugin/host.js
// info()), make a config model's package and URL: provider.npm and
// provider.api on the model, else the provider's own.
function hostResolves(cfg: { npm?: string; api?: string; models: Record<string, any> }, key: string) {
  const m = cfg.models[key]
  return { npm: m.provider?.npm ?? cfg.npm ?? "@ai-sdk/openai-compatible", url: m.provider?.api ?? cfg.api ?? "" }
}

test("a config model is placed where a host reads it: provider.npm and provider.api", async () => {
  const site = { ...CN(), models: [["claude-opus-5.5", "Claude-Opus-5.5", 1000000, ["low", "max"]], ["glm-5.3", "GLM-5.3", 1000000, ["low", "high"]]] as any }
  const models = _internal.configModels(site)
  const cfg = { npm: "@ai-sdk/openai-compatible", api: "https://copilot.tencent.com/v2", models }
  expect(hostResolves(cfg, "claude-opus-5.5")).toEqual({ npm: "@ai-sdk/anthropic", url: "https://copilot.tencent.com/v1" })
  expect(hostResolves(cfg, "glm-5.3")).toEqual({ npm: "@ai-sdk/openai-compatible", url: "https://copilot.tencent.com/v2" })
  // and on WorkBuddy AI a Claude model stays on chat
  const ai = _internal.configModels({ ...AI(), models: [["claude-opus-5.5", "Claude-Opus-5.5", 1000000]] as any })
  expect(hostResolves({ npm: "@ai-sdk/openai-compatible", api: "https://www.workbuddy.ai/v2", models: ai }, "claude-opus-5.5"))
    .toEqual({ npm: "@ai-sdk/openai-compatible", url: "https://www.workbuddy.ai/v2" })
})

test("the plugin's config hook keeps the provider on chat, its static list too", async () => {
  const hooks = await WorkBuddyAuthPlugin({ client: { auth: { set: async () => {} } } })
  const config: any = {}
  await hooks.config(config)
  const p = config.provider.workbuddy
  expect(p.npm).toBe("@ai-sdk/openai-compatible")
  expect(p.api).toBe("https://copilot.tencent.com/v2")
  expect(hostResolves(p, "glm-5.3")).toEqual({ npm: "@ai-sdk/openai-compatible", url: "https://copilot.tencent.com/v2" })
})

const configOf = (efforts: string[]) =>
  JSON.stringify({
    data: {
      agents: [{ name: "cli", models: ["claude-opus-5.5", "glm-5.3"] }],
      models: [
        { id: "claude-opus-5.5", name: "Claude-Opus-5.5", supportsReasoning: true, maxInputTokens: 1000000, reasoning: { supportedEfforts: efforts } },
        { id: "glm-5.3", name: "GLM-5.3", supportsReasoning: true, maxInputTokens: 1000000, reasoning: { supportedEfforts: ["low", "high", "xhigh"] } },
      ],
    },
  })
async function listed(site: any, cfg: string) {
  setFetch(async () => new Response(cfg))
  const out = await _internal.liveModels(site, { access: "a", uid: "u" })
  return Object.fromEntries(out.map((m) => [m.id, m.efforts]))
}

test("a Claude model on Messages lists max though the config stops at xhigh", async () => {
  const e = await listed(CN(), configOf(["low", "medium", "high", "xhigh"]))
  expect(e["claude-opus-5.5"]).toEqual(["none", "low", "medium", "high", "xhigh", "max"])
  // a model on chat keeps what the config says: max means nothing more there
  expect(e["glm-5.3"]).toEqual(["none", "low", "high", "xhigh"])
})

test("on WorkBuddy AI a Claude model keeps the config's levels: it would go to chat", async () => {
  const e = await listed(AI(), configOf(["low", "medium", "high", "xhigh"]))
  expect(e["claude-opus-5.5"]).toEqual(["none", "low", "medium", "high", "xhigh"])
})

test("isMessages goes by the URL, and by the body when there is none", () => {
  const { isMessages } = _internal
  expect(isMessages("https://copilot.tencent.com/v1/messages", "")).toBe(true)
  expect(isMessages("https://copilot.tencent.com/v2/chat/completions", "")).toBe(false)
  expect(isMessages(new URL("https://copilot.tencent.com/v1/messages?beta=true"), "")).toBe(true)
  expect(isMessages("", JSON.stringify({ system: [{ type: "text", text: "x" }], messages: [] }))).toBe(true)
  expect(isMessages("", JSON.stringify({ tools: [{ name: "Read", input_schema: { type: "object" } }], messages: [] }))).toBe(true)
  expect(isMessages("", JSON.stringify({ tools: [{ type: "function", function: { name: "Read", parameters: {} } }], messages: [] }))).toBe(false)
  expect(isMessages("", "not json")).toBe(false)
})

// ---- one user send is one request (#48), in Anthropic's shape too ----------

// ccLoop is a Claude Code send as it reaches the route, step by step: the
// user's words with a reminder beside them; a {role: "system"} message of
// Claude Code's own between steps (its environment, its token count); each
// step an assistant message of thinking and tool_use, answered by a user
// message of tool_result blocks — one with a reminder beside its result, as
// Claude Code puts one there. Taken from the bodies a Claude Code 2.1.307
// session sent on 2026-10-24.
function ccLoop() {
  const u0 = { role: "user", content: [{ type: "text", text: "<system-reminder>\nAttribution for git commits...\n</system-reminder>" }, { type: "text", text: "Read hello.py, fix the bug, then run it." }] }
  const env = { role: "system", content: "# Environment\nYou have been invoked in the following environment..." }
  const a1 = { role: "assistant", content: [{ type: "thinking", thinking: "Read it first.", signature: "CAQSa1" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/w/hello.py" } }] }
  const r1 = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "def greet(name):\n    return 'hi ' + nam" }, { type: "text", text: "<system-reminder>The file is short.</system-reminder>" }] }
  const t1 = { role: "system", content: [{ type: "text", text: "<total_tokens>14982892 tokens left</total_tokens>" }] }
  const a2 = { role: "assistant", content: [{ type: "thinking", thinking: "Typo.", signature: "CAQSa2" }, { type: "tool_use", id: "toolu_2", name: "Edit", input: {} }, { type: "tool_use", id: "toolu_3", name: "Bash", input: {} }] }
  const r2 = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "ok" }, { type: "tool_result", tool_use_id: "toolu_3", content: "hi x" }] }
  const t2 = { role: "system", content: [{ type: "text", text: "<total_tokens>14982595 tokens left</total_tokens>" }] }
  const a3 = { role: "assistant", content: [{ type: "text", text: "Fixed." }] }
  const u1 = { role: "user", content: "Now add a docstring." }
  const a4 = { role: "assistant", content: [{ type: "tool_use", id: "toolu_4", name: "Edit", input: {} }] }
  const r4 = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_4", content: "ok" }] }
  const steps = [
    [u0, env],
    [u0, env, a1, r1, t1],
    [u0, env, a1, r1, t1, a2, r2, t2],
    // the user's next message
    [u0, env, a1, r1, t1, a2, r2, t2, a3, u1],
    [u0, env, a1, r1, t1, a2, r2, t2, a3, u1, a4, r4],
  ]
  return steps.map((messages) => JSON.stringify({ model: "claude-opus-5.5", stream: true, system: [{ type: "text", text: "You are Claude Code." }], messages }))
}

function turnsOf(bodies: string[], session: string) {
  return bodies.map((b) => {
    const h = new Headers()
    _internal.attend(h, b, session)
    return { turn: h.get("X-Conversation-Request-ID"), conv: h.get("X-Conversation-ID"), msg: h.get("X-Conversation-Message-ID") }
  })
}

test("each step of one Claude Code send carries one turn id; the user's next message another", () => {
  const ids = turnsOf(ccLoop(), "sess-1")
  // the first send: three steps, one turn
  expect(new Set(ids.slice(0, 3).map((x) => x.turn)).size).toBe(1)
  // the next user message: a turn of its own, every step of it the same
  expect(ids[3].turn).not.toBe(ids[0].turn)
  expect(ids[4].turn).toBe(ids[3].turn)
  // one conversation, and a message id each
  expect(new Set(ids.map((x) => x.conv)).size).toBe(1)
  expect(new Set(ids.map((x) => x.msg)).size).toBe(ids.length)
})

test("without a session the conversation is still known by its first user message", () => {
  const ids = turnsOf(ccLoop(), "")
  expect(new Set(ids.map((x) => x.conv)).size).toBe(1)
  expect(new Set(ids.slice(0, 3).map((x) => x.turn)).size).toBe(1)
})

test("a tool result in Anthropic's shape answers, and so does a message right after it", () => {
  const { answeredBefore } = _internal
  const msgs = JSON.parse(ccLoop()[2]).messages
  expect(answeredBefore(msgs, 0)).toBe(false) // the user's own words
  expect(answeredBefore(msgs, 3)).toBe(true) // tool_result, reminder beside it
  expect(answeredBefore(msgs, 6)).toBe(true) // two tool_results
  // a user message right after a tool_result message, with a system one
  // between (pi's images of a tool's result go like this)
  const after = [msgs[2], msgs[3], { role: "system", content: "x" }, { role: "user", content: [{ type: "image", source: {} }] }]
  expect(answeredBefore(after, 3)).toBe(true)
  // a chat's own shapes still answer
  expect(answeredBefore([{ role: "assistant", tool_calls: [{ id: "c" }] }, { role: "user", content: "x" }], 1)).toBe(true)
  expect(answeredBefore([{ role: "tool", content: "r" }, { role: "user", content: "x" }], 1)).toBe(true)
  expect(answeredBefore([{ role: "assistant", content: "plain" }, { role: "user", content: "x" }], 1)).toBe(false)
})

// ---- unsigned thinking --------------------------------------------------------

test("thinking without a signature is left out of a Messages body; signed thinking stays", () => {
  const body = JSON.stringify({
    model: "claude-opus-5.5",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "from chat, unsigned" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "unsigned alone" }] },
      { role: "user", content: "go on" },
      { role: "assistant", content: [{ type: "thinking", thinking: "signed", signature: "CAQSz" }, { type: "text", text: "ok" }] },
      { role: "user", content: "more" },
    ],
  })
  const out = JSON.parse(_internal.withoutUnsigned(body) as string)
  expect(out.messages[1].content).toEqual([{ type: "tool_use", id: "t1", name: "Read", input: {} }])
  expect(out.messages[3].content).toEqual([{ type: "text", text: "" }])
  expect(out.messages[5].content).toEqual([{ type: "thinking", thinking: "signed", signature: "CAQSz" }, { type: "text", text: "ok" }])
  // a body with none is passed on as it is, byte for byte
  const clean = JSON.stringify({ model: "claude-opus-5.5", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] }] })
  expect(_internal.withoutUnsigned(clean)).toBe(clean)
  expect(_internal.withoutUnsigned("not json")).toBe("not json")
})

// ---- the loader's fetch on a Messages URL --------------------------------------

const MSGS = "https://copilot.tencent.com/v1/messages"
const REFRESH = "/v2/plugin/auth/token/refresh"
const later = () => Date.now() + 340 * 86400_000
const signedIn = (over: any = {}) => ({ type: "oauth", access: "old", refresh: "r1", expires: later(), refreshExpiresAt: later(), uid: "u1", domain: "www.workbuddy.cn", enterpriseId: "ent1", ...over })
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, msg: "OK", data }))
const RENEWED = { accessToken: "new", refreshToken: "r2", expiresIn: 340 * 86400, refreshExpiresIn: 340 * 86400 }
const SSE = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
const refusedToken = () =>
  new Response("<html>401</html>", { status: 401, headers: { "content-type": "text/html", "www-authenticate": 'Bearer realm="copilot", error="invalid_token"' } })

function serve({ good = ["old"] }: { good?: string[] } = {}) {
  const calls: any[] = []
  setFetch(async (url, init) => {
    const u = new URL(String(url instanceof Request ? url.url : url))
    const headers = new Headers(init?.headers)
    calls.push({ url: u.href, path: u.pathname, headers, body: init?.body })
    if (u.pathname === REFRESH) return ok(RENEWED)
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "")
    return good.includes(token) ? new Response(SSE, { headers: { "content-type": "text/event-stream" } }) : refusedToken()
  })
  return calls
}

async function send(body: string, { auth = signedIn(), headers = {} }: { auth?: any; headers?: Record<string, string> } = {}) {
  const sets: any[] = []
  const hooks = await WorkBuddyAuthPlugin({ client: { auth: { set: async (x: any) => sets.push(x) } } })
  const opts = await hooks.auth.loader(async () => auth)
  const res = await chatFetch(opts)(MSGS, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "unused", ...headers }, body })
  return { res, opts, sets }
}

// what Claude Code sends: its billing line and identity in system, a
// developer-free shape, tools with input_schema whose names a chat would
// rename, max_tokens as Anthropic spells it, effort as output_config
const CC_BODY = JSON.stringify({
  model: "claude-opus-5.5",
  max_tokens: 64000,
  stream: true,
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.307; cc_entrypoint=cli; cch=abc;" },
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral", ttl: "1h" } },
  ],
  tools: [{ name: "mcp__srv__tool.name", description: "d", input_schema: { type: "object", properties: {} } }],
  thinking: { type: "adaptive" },
  output_config: { effort: "max" },
  messages: [{ role: "user", content: "Say ok." }],
})

test("a Messages request goes to /v1/messages byte for byte as sent, with WorkBuddy's headers", async () => {
  const calls = serve()
  const { res, opts } = await send(CC_BODY)
  expect(opts.baseURL).toBe("")
  expect(res.status).toBe(200)
  expect(await res.text()).toBe(SSE)
  expect(calls.length).toBe(1)
  const c = calls[0]
  expect(c.url).toBe(MSGS)
  // nothing of the chat route's rewrites: no default system message, no
  // max_tokens respelling, no tool renaming, no rewording
  expect(c.body).toBe(CC_BODY)
  expect(c.headers.get("authorization")).toBe("Bearer old")
  expect(c.headers.get("x-api-key")).toBeNull()
  expect(c.headers.get("user-agent")).toMatch(/^WorkBuddy\//)
  expect(c.headers.get("x-ide-type")).toBe("WorkBuddy")
  expect(c.headers.get("x-enterprise-id")).toBe("ent1")
  expect(c.headers.get("x-conversation-request-id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(c.headers.get("x-conversation-id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test("a Messages body with unsigned thinking goes without it, the rest as sent", async () => {
  const calls = serve()
  const body = JSON.stringify({
    model: "claude-opus-5.5", stream: true,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "from chat" }, { type: "text", text: "hello" }] },
      { role: "user", content: "again" },
    ],
  })
  await send(body)
  const sent = JSON.parse(calls[0].body as string)
  expect(sent.messages[1].content).toEqual([{ type: "text", text: "hello" }])
  expect(sent.messages[0]).toEqual({ role: "user", content: "hi" })
})

test("a 401 on Messages is renewed once and sent again, the body as it was", async () => {
  const calls = serve({ good: ["new"] })
  const { res, sets } = await send(CC_BODY)
  expect(res.status).toBe(200)
  const asked = calls.filter((c) => c.path === "/v1/messages")
  expect(asked.length).toBe(2)
  expect(asked[0].headers.get("authorization")).toBe("Bearer old")
  expect(asked[1].headers.get("authorization")).toBe("Bearer new")
  expect(asked[1].body).toBe(CC_BODY)
  expect(calls.filter((c) => c.path === REFRESH).length).toBe(1)
  expect(sets.some((x) => x?.body?.access === "new")).toBe(true)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
})

test("a 401 renewed and refused again is not sent a third time", async () => {
  const calls = serve({ good: [] })
  const { res } = await send(CC_BODY)
  expect(res.status).toBe(401)
  expect(calls.filter((c) => c.path === "/v1/messages").length).toBe(2)
})

test("the steps of one Claude Code send through the loader carry one turn id", async () => {
  const calls = serve()
  for (const b of ccLoop()) await send(b, { headers: { [_internal.SESSION]: "sess-9" } })
  const turns = calls.map((c) => c.headers.get("x-conversation-request-id"))
  expect(new Set(turns.slice(0, 3)).size).toBe(1)
  expect(turns[3]).not.toBe(turns[0])
  expect(turns[4]).toBe(turns[3])
  expect(new Set(calls.map((c) => c.headers.get("x-conversation-id"))).size).toBe(1)
  // the session header goes no further than the plugin
  expect(calls.every((c) => !c.headers.has(_internal.SESSION))).toBe(true)
})

test("a chat request still goes through the chat route's rewrites", async () => {
  const calls = serve()
  const hooks = await WorkBuddyAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => signedIn())
  const body = JSON.stringify({ model: "glm-5.3", max_completion_tokens: 4096, stream: true, messages: [{ role: "user", content: "hi" }] })
  await chatFetch(opts)("https://copilot.tencent.com/v2/chat/completions", { method: "POST", body })
  const sent = JSON.parse(calls[0].body as string)
  expect(sent.max_tokens).toBe(4096)
  expect(sent.max_completion_tokens).toBeUndefined()
  expect(sent.messages[0].role).toBe("system")
})

// ---- the Messages route's error envelopes ----------------------------------------

// The envelopes are as the route answered on 2026-10-24: an entitlement
// refusal as {"code": 11102, "error": "11158:…"}, a refused signature as
// {"error": {"code": "400001", "internal_code": "11159", …}}. 11140 and
// 14018 weren't met there; they are put in the same two envelopes, as the
// route words a code, to see them told.
const explain = async (body: unknown, status = 400) => {
  const r = await _internal.explained(new Response(JSON.stringify(body), { status }))
  return { status: r.status, said: r.headers.get("X-Magpie-Sign-In"), body: await r.text() }
}

test("a code inside the Messages route's envelope is read: restricted and credits used up", async () => {
  for (const env of [
    { code: 11102, error: "11140:request illegal", type: "invalid_request_error" },
    { error: { code: "400001", internal_code: "11140", message: "request illegal" }, type: "error" },
  ]) {
    const r = await explain(env, 403)
    expect(JSON.parse(r.body).error.code).toBe(11140)
    expect(r.said).toBe("kept")
  }
  for (const env of [
    { code: 11102, error: "14018:quota", type: "invalid_request_error" },
    { error: { code: "400001", internal_code: "14018", message: "quota" }, type: "error" },
  ]) {
    const r = await explain(env, 429)
    expect(JSON.parse(r.body).error.code).toBe(14018)
  }
})

test("an entitlement refusal or a refused signature on Messages passes as it came", async () => {
  const entitlement = { code: 11102, error: "11158:model [claude-opus-4.7-1m] is not allowed for user type [internal_enterprise_user]", type: "invalid_request_error" }
  const r1 = await explain(entitlement)
  expect(JSON.parse(r1.body)).toEqual(entitlement)
  const sig = { error: { code: "400001", internal_code: "11159", message: "content.0: Invalid `signature` in `thinking` block." }, type: "error" }
  const r2 = await explain(sig, 500)
  expect(JSON.parse(r2.body)).toEqual(sig)
  expect(r2.status).toBe(500)
})

// ---- the reviewer's open question: the emptied assistant turn ----------------

test("a history whose assistant turn was emptied of unsigned thinking answers, as an empty text block", () => {
  // Replayed against WorkBuddy on 2026-10-24, with a real account, three
  // runs each: the unsigned block itself + a signed turn after it -> 11159;
  // the same with [{type:"text",text:""}] in its place -> 200, twice over.
  // So the empty text block is what WorkBuddy takes, where Anthropic's own
  // API refuses one. The test pins the shape withoutUnsigned leaves.
  const body = JSON.stringify({
    model: "claude-opus-5.5",
    messages: [
      { role: "user", content: "Earlier question." },
      { role: "assistant", content: [{ type: "thinking", thinking: "unsigned" }] },
      { role: "user", content: "Carry on." },
      { role: "assistant", content: [{ type: "thinking", thinking: "signed", signature: "CAQSz" }, { type: "text", text: "ok" }] },
      { role: "user", content: "Say OK." },
    ],
  })
  const out = JSON.parse(_internal.withoutUnsigned(body) as string)
  // not an empty content list: a message must keep a block, and the empty
  // text block is the one WorkBuddy takes
  expect(out.messages[1].content).toEqual([{ type: "text", text: "" }])
  expect(_internal.withoutSignedThinking(body) && JSON.parse(_internal.withoutSignedThinking(body)).messages[1].content)
    .toEqual([{ type: "text", text: "" }])
  // and the signed one is untouched
  expect(out.messages[3].content).toEqual([{ type: "thinking", thinking: "signed", signature: "CAQSz" }, { type: "text", text: "ok" }])
})

// ---- a signature WorkBuddy didn't make -----------------------------------------

test("a signature WorkBuddy didn't make is refused once, then the request goes without thinking", async () => {
  // Measured 2026-10-24: another vendor's signature (valid base64, right
  // length) answers 11159, drop_block notwithstanding; the same history
  // without the block answers 200. A session moved here from another
  // provider keeps such blocks, and a truncated one reads the same way.
  const REFUSAL = JSON.stringify({
    error: { code: "400001", internal_code: "11159", message: "content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation." },
    type: "error",
  })
  let n = 0
  const seen: any[] = []
  setFetch(async (url, init) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/token/refresh")) return ok(RENEWED)
    n++
    seen.push(JSON.parse(init.body as string))
    // the first try is refused, the retry (without thinking) answers
    return n === 1 ? new Response(REFUSAL, { status: 500 }) : new Response(SSE, { headers: { "content-type": "text/event-stream" } })
  })
  const body = JSON.stringify({
    model: "claude-opus-5.5", stream: true,
    thinking: { type: "adaptive" },
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "foreign", signature: "Zm9yZWlnbg==" }, { type: "text", text: "hello" }] },
      { role: "user", content: "again" },
    ],
  })
  const { res } = await send(body)
  expect(res.status).toBe(200)
  expect(n).toBe(2)
  // the retry dropped the thinking block, and only that
  expect(seen[1].messages[1].content).toEqual([{ type: "text", text: "hello" }])
  expect(seen[1].messages[0]).toEqual(seen[0].messages[0])
  expect(seen[1].thinking).toEqual({ type: "adaptive" })
})

test("a body with no thinking block isn't sent twice for a 400", async () => {
  let n = 0
  setFetch(async (url) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/token/refresh")) return ok(RENEWED)
    n++
    return new Response(JSON.stringify({ error: { internal_code: "11159", message: "Invalid `signature` in `thinking` block" } }), { status: 500 })
  })
  const { res } = await send(JSON.stringify({ model: "claude-opus-5.5", stream: true, messages: [{ role: "user", content: "hi" }] }))
  expect(res.status).toBe(500)
  expect(n).toBe(1)
})

test("a refusal that isn't about a signature isn't retried", async () => {
  let n = 0
  setFetch(async (url) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/token/refresh")) return ok(RENEWED)
    n++
    return new Response(JSON.stringify({ code: 11102, error: "11158:model [claude-opus-4.7-1m] is not allowed for user type [internal_enterprise_user]", type: "invalid_request_error" }), { status: 400 })
  })
  const { res } = await send(JSON.stringify({
    model: "claude-opus-5.5", stream: true,
    messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] }, { role: "user", content: "go" }],
  }))
  expect(res.status).toBe(400)
  expect(n).toBe(1)
})

test("count_tokens is a Messages request, not a chat", () => {
  expect(_internal.isMessages("https://copilot.tencent.com/v1/messages/count_tokens", "")).toBe(true)
  expect(_internal.isMessages("https://copilot.tencent.com/v2/chat/completions", "")).toBe(false)
})
