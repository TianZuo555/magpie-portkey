// One user send is one request to WorkBuddy's backend, whatever it takes:
// every step of it — a tool result sent back, a retry, another account
// answering — carries the same X-Conversation-Request-ID, and the user's next
// message carries another. A conversation's turns share its
// X-Conversation-ID, from the session magpie (or OpenCode) names, else from
// the chat's first user message; each request has a message id of its own.
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAIAuthPlugin, WorkBuddyAuthPlugin, _internal } from "./index.mjs"

const { SESSION, signatureOf } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

// ask sends a chat as magpie's host does: the chat.headers hook is told the
// session, then the loader's fetch is given what it added, and the request
// WorkBuddy was sent is read back. Nothing leaves the machine.
async function ask(body, { session = "", provider = "workbuddy", plugin = WorkBuddyAuthPlugin, headers = {} } = {}) {
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push(new Headers(init?.headers))
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  const hooks = await plugin({ client: {} })
  const out = { headers: { ...headers } }
  await hooks["chat.headers"]({ sessionID: session, model: { providerID: provider, id: "glm-5.3" }, provider: { info: { id: provider } } }, out)
  const l = await hooks.auth.loader(async () => ({ type: "oauth", access: "tok", uid: "u1", expires: Date.now() + 3600_000 }))
  const res = await l.fetch("https://copilot.tencent.com/v2/chat/completions", {
    method: "POST",
    headers: new Headers(out.headers),
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return sent.at(-1)
}

const chat = (...messages) => ({ model: "glm-5.3", stream: true, messages })
const system = { role: "system", content: "be brief" }
// send is a user send: its message, and nothing of what answering it added
const send = (text) => chat(system, { role: "user", content: text })
// later is a send of a conversation that has been answered before
const later = (first, text) => chat(system, { role: "user", content: first }, { role: "assistant", content: "hi" }, { role: "user", content: text })
const call = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] }
const result = { role: "tool", tool_call_id: "c1", content: "a.go" }
const HEX32 = /^[0-9a-f]{32}$/
const turn = (h) => h.get("x-conversation-request-id")
const conv = (h) => h.get("x-conversation-id")
const message = (h) => h.get("x-conversation-message-id")

test("one send's steps carry one turn id; the user's next message another", async () => {
  const asked = await ask(send("跑一下"))
  const called = await ask(chat(system, { role: "user", content: "跑一下" }, call))
  const answered = await ask(chat(system, { role: "user", content: "跑一下" }, call, result))
  const ids = [asked, called, answered].map(turn)
  expect(ids[0]).toMatch(HEX32)
  expect(new Set(ids).size).toBe(1)
  // the user's next message is another turn
  expect(turn(await ask(later("跑一下", "再来一次")))).not.toBe(ids[0])
  // the same words asked again later are a turn of their own too: the place
  // of the message is part of the key
  expect(turn(await ask(chat(system, { role: "user", content: "跑一下" }, { role: "assistant", content: "hi" }, { role: "user", content: "跑一下" })))).not.toBe(ids[0])
  // the message's id is its own on each request, and is the request's id
  expect(new Set([asked, called, answered].map(message)).size).toBe(3)
  for (const h of [asked, called, answered]) expect(message(h)).toBe(h.get("x-request-id"))
})

test("a conversation's turns share one id, named by the session magpie gives", async () => {
  const one = await ask(send("fix the bug"), { session: "ses_1" })
  const two = await ask(later("fix the bug", "and then?"), { session: "ses_1" })
  expect(conv(one)).toMatch(HEX32)
  expect(conv(two)).toBe(conv(one))
  // another session is another conversation, the same words or not
  const other = await ask(send("fix the bug"), { session: "ses_2" })
  expect(conv(other)).not.toBe(conv(one))
  // and the session itself goes no further than here
  for (const h of [one, two]) expect(h.get(SESSION)).toBe(null)
})

test("with no session, the first user message names the conversation", async () => {
  const one = await ask(send("hi"))
  const two = await ask(chat(system, { role: "user", content: "hi" }, { role: "assistant", content: "hi" }, call, result))
  expect(conv(one)).toMatch(HEX32)
  // a step of the same send: the same conversation, and the same turn
  expect(conv(two)).toBe(conv(one))
  expect(turn(two)).toBe(turn(one))
  // the user's next message: the same conversation, a turn of its own
  const next = await ask(later("hi", "and then?"))
  expect(conv(next)).toBe(conv(one))
  expect(turn(next)).not.toBe(turn(one))
  expect(conv(await ask(send("hello")))).not.toBe(conv(one))
  // an image of its own is a conversation's first message too, and signs it
  const image = await ask(chat(system, { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }))
  expect(conv(image)).toMatch(HEX32)
  expect(conv(image)).not.toBe(conv(one))
})

test("nothing names a conversation: no conversation id, the turn's still there", async () => {
  // no user message at all
  const none = await ask(chat(system))
  expect(conv(none)).toBe(null)
  expect(turn(none)).toMatch(HEX32)
  // a body that isn't a chat
  const bytes = await ask("not json")
  expect(conv(bytes)).toBe(null)
  expect(turn(bytes)).toMatch(HEX32)
  expect(new Set([turn(none), turn(bytes)]).size).toBe(2)
})

test("a caller's own ids are kept", async () => {
  const h = await ask(send("hi"), { headers: { "x-conversation-request-id": "caller-turn", "x-conversation-id": "caller-conv" } })
  expect(turn(h)).toBe("caller-turn")
  expect(conv(h)).toBe("caller-conv")
})

test("WorkBuddy AI takes the ids too, with its client's headers", async () => {
  const ai = await ask(send("hi"), { provider: "workbuddy-ai", plugin: WorkBuddyAIAuthPlugin })
  expect(turn(ai)).toMatch(HEX32)
  expect(conv(ai)).toMatch(HEX32)
  expect(ai.get("x-ide-name")).toBe("WorkBuddy")
  expect(ai.get("user-agent")).toBe("WorkBuddy/5.5.6")
})

test("both builds carry what the usage list shows as the client (使用端)", async () => {
  // WorkBuddy's own client sends the whole attribution group on both builds;
  // a chat missing any of it is counted under no client at all
  const attribution = {
    "x-agent-purpose": "conversation",
    "x-ide-name": "WorkBuddy",
    "x-ide-type": "WorkBuddy",
    "x-ide-version": "5.5.6",
    "x-product": "SaaS",
    "x-agent-intent": "craft",
    "x-requested-with": "XMLHttpRequest",
  }
  for (const [provider, plugin] of [["workbuddy", WorkBuddyAuthPlugin], ["workbuddy-ai", WorkBuddyAIAuthPlugin]]) {
    const h = await ask(send("hi"), { provider, plugin })
    for (const [name, want] of Object.entries(attribution)) {
      expect([provider, name, h.get(name)]).toEqual([provider, name, want])
    }
  }
})

test("the hook leaves other providers' requests alone", async () => {
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "ses_1", model: { providerID: "workbuddy-ai" }, provider: { info: { id: "workbuddy-ai" } } }, out)
  expect(out.headers).toEqual({})
})

test("a message's signature is its text, a digest of what isn't, no tool result", () => {
  expect(signatureOf("a")).toBe("a")
  expect(signatureOf([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab")
  expect(signatureOf([{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }])).toMatch(/^\[image_url:[0-9a-f]{8}\]$/)
  // Anthropic's shape: a tool result carried beside the user's own words
  const carried = [{ type: "tool_result", tool_use_id: "c1", content: "a.go" }, { type: "text", text: "now answer" }]
  expect(signatureOf(carried)).toBe("now answer")
  expect(signatureOf([{ type: "tool_result", tool_use_id: "c1", content: "a.go" }])).toBe("")
  expect(signatureOf(null)).toBe("")
  expect(signatureOf(undefined)).toBe("")
})

test("a tool result carried in a user message is not the user's words", async () => {
  // Anthropic's shape: the result rides in a user message right after the call
  const carried = (out) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: out }] })
  const one = await ask(chat(system, { role: "user", content: "hi" }, call, carried("a.go")))
  const two = await ask(chat(system, { role: "user", content: "hi" }, call, carried("b.go")))
  expect(turn(one)).toBe(turn(two))
  expect(conv(one)).toBe(conv(two))
  // the user's own next message still changes the turn
  const next = await ask(chat(system, { role: "user", content: "hi" }, call, carried("b.go"), { role: "assistant", content: "done" }, { role: "user", content: "and then?" }))
  expect(turn(next)).not.toBe(turn(one))
})

test("a tool result's image sent as a user message is not a turn of its own", async () => {
  // pi sends a result's images in a user message right after the result
  const attached = (image) => ({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image_url", image_url: { url: "data:image/png;base64," + image } }] })
  const call2 = { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read_image", arguments: "{}" } }] }
  const result2 = { role: "tool", tool_call_id: "c2", content: "b.png" }
  const head = [system, { role: "user", content: "看图" }]
  const ids = [
    await ask(chat(...head, call)),
    await ask(chat(...head, call, result, attached("AA"))),
    await ask(chat(...head, call, result, attached("AA"), call2, result2, attached("BB"))),
  ].map(turn)
  expect(ids[0]).toMatch(HEX32)
  expect(new Set(ids).size).toBe(1)
})

test("the same words in another conversation are another turn", async () => {
  const one = await ask(send("继续"), { session: "ses_1" })
  const other = await ask(send("继续"), { session: "ses_2" })
  expect(turn(other)).not.toBe(turn(one))
  // with no session either: the first message names the conversation, and the
  // turn with it
  const a = await ask(later("fix it", "继续"))
  expect(turn(await ask(later("fix it", "继续")))).toBe(turn(a))
  expect(turn(await ask(later("other", "继续")))).not.toBe(turn(a))
})
