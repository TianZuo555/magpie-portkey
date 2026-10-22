import { setFetch, parse, chatFetch, type Call, type Save } from "./test-helpers.ts"
import type { Account, Client, MagpiePlugin, WireRecord } from "./types.ts"
// WorkBuddy AI's gemini-3.8-flash answers tool results followed by the
// user's message with 400 code 11153, "the conversation must end with a user
// message" (#113). The body is the one www.workbuddy.ai sent on 2026-10-14.
import { expect, test } from "bun:test"
import { WorkBuddyAIAuthPlugin, _internal } from "./index.ts"

const { replyAfterTools } = _internal

const REFUSAL = JSON.stringify({
  code: 11153,
  msg: "the conversation must end with a user message",
  requestId: "555fb7db0fb1ef01abc76992cbfcad0e",
  extError: { code: "400001", message: "the conversation must end with a user message", param: "", type: "invalid_request_error", StatusCode: 400, Request: null, Response: null },
  displayMsg: { en: "This conversation must end with a user message. Please add your input and retry." },
})

const call = { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } }] }
const result = { role: "tool", tool_call_id: "call_1", content: "a.txt\nb.txt" }
const ask = { role: "user", content: "List the files." }
const reminder = { role: "user", content: [{ type: "text", text: "<system-reminder>note</system-reminder>" }] }

// served answers like gemini-3.8-flash: tool results then a user message are
// refused, anything else is served
async function withService(fn) {
  const realFetch = globalThis.fetch
  const sent = []
  setFetch(async (_url, init) => {
    const b = parse(init.body)
    sent.push(b)
    const m = b.messages
    let i = m.length - 1
    while (i >= 0 && m[i].role === "user") i--
    if (m.at(-1).role !== "user" || (i < m.length - 1 && m[i]?.role === "tool")) {
      return new Response(REFUSAL, { status: 400, headers: { "content-type": "application/json" } })
    }
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  })
  try {
    const hooks = await WorkBuddyAIAuthPlugin({ client: {} })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "access", uid: "uid", expires: Date.now() + 3600_000 }))
    const post = (model, messages) =>
      chatFetch(loader)("https://www.workbuddy.ai/v2/chat/completions", { method: "POST", body: JSON.stringify({ model, stream: true, messages }) })
    await fn(post, sent)
  } finally {
    setFetch(realFetch)
  }
}

test("tool results then the user's message go again with an empty reply between them", async () => {
  await withService(async (post, sent) => {
    const res = await post("gemini-after-tools-a", [ask, call, result, reminder])
    expect(res.status).toBe(200)
    expect(sent.length).toBe(2)
    const roles = sent[1].messages.map((m) => m.role)
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant", "user"])
    expect(sent[1].messages[4]).toEqual({ role: "assistant", content: "" })
    // what the user said is still the user's, last
    expect(sent[1].messages[5]).toEqual(reminder)
  })
})

test("a model that refused it gets the empty reply up front on its next chat", async () => {
  await withService(async (post, sent) => {
    await post("gemini-after-tools-b", [ask, call, result, reminder])
    sent.length = 0
    const res = await post("gemini-after-tools-b", [ask, call, result, ask, reminder])
    expect(res.status).toBe(200)
    expect(sent.length).toBe(1)
    expect(sent[0].messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user", "user"])
    // another model is asked as it was sent
    const other = await post("deepseek-after-tools-b", [ask, call, result, { role: "assistant", content: "Two." }, ask])
    expect(other.status).toBe(200)
    expect(sent.length).toBe(2)
    expect(sent[1].messages.filter((m) => m.role === "assistant" && m.content === "").length).toBe(0)
  })
})

test("a chat ending with the assistant's message is a prefill, refused as it was", async () => {
  await withService(async (post, sent) => {
    const res = await post("gemini-after-tools-c", [ask, call, result, { role: "assistant", content: "There are" }])
    expect(res.status).toBe(400)
    expect(sent.length).toBe(1)
    expect((await res.json()).msg).toBe("the conversation must end with a user message")
  })
})

test("replyAfterTools changes only tool results followed by user messages", () => {
  const body = (messages) => JSON.stringify({ model: "m", messages })
  expect(parse(replyAfterTools(body([ask, call, result, ask, reminder]))).messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "user"])
  expect(replyAfterTools(body([ask]))).toBeNull()
  expect(replyAfterTools(body([ask, call, result]))).toBeNull()
  expect(replyAfterTools(body([ask, call, result, { role: "assistant", content: "ok" }, ask]))).toBeNull()
  expect(replyAfterTools(body([ask, { role: "assistant", content: "hi" }]))).toBeNull()
  expect(replyAfterTools("not json")).toBeNull()
})
