// What a chat says it is: the desktop client's own marks on it, measured on
// its 5.8.3 build against its own chats. attend gives a chat the client's
// id headers (UUIDv7s, the root request id of the turn's); chatHeaders puts
// on the SDK's marks, the trace, the ACP connection, and the marks that say
// the request is the client's own. Nothing here leaves the machine.
import { afterEach, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import { setFetch, chatFetch } from "./test-helpers.ts"
import type { MagpiePlugin } from "./types.ts"
import { WorkBuddyAuthPlugin, _internal } from "./index.ts"

const { uuid7, idFor, attend, chatHeaders, desktopVersion, SITES } = _internal
const real = globalThis.fetch
afterEach(() => setFetch(real))

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ask sends a chat as magpie's host does and reads back the headers the
// request went to WorkBuddy with.
let lastBody: unknown
async function ask(body: unknown, { session = "" }: { session?: string } = {}) {
  const sent: Headers[] = []
  setFetch(async (_url, init) => {
    sent.push(new Headers(init?.headers))
    lastBody = init?.body
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  })
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const out: { headers: Record<string, string> } = { headers: {} }
  await hooks["chat.headers"]({ sessionID: session, model: { providerID: "workbuddy", id: "glm-5.3" } as any, provider: { info: { id: "workbuddy" } } }, out)
  const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: "tok", uid: "u1", expires: Date.now() + 3600_000 }))
  const res = await chatFetch(loader)("https://copilot.tencent.com/v2/chat/completions", {
    method: "POST",
    headers: new Headers(out.headers),
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return sent.at(-1)!
}

test("uuid7 is the shape of the desktop client's ids, of this moment", () => {
  const id = uuid7()
  expect(id).toMatch(UUID7)
  const ms = parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
  expect(Math.abs(Date.now() - ms)).toBeLessThan(60_000)
})

test("idFor keeps one id for one key, a UUIDv7 each", () => {
  const turn = idFor("turn", "one send")
  expect(turn).toMatch(UUID7)
  expect(idFor("turn", "one send")).toBe(turn)
  expect(idFor("turn", "another send")).not.toBe(turn)
  expect(idFor("conversation", "one send")).not.toBe(turn)
})

test("attend gives a chat the client's id headers", () => {
  const h = new Headers()
  attend(h, JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hello" }] }), "")
  expect(h.get("X-Conversation-Message-ID")).toMatch(UUID7)
  expect(h.get("X-Request-ID")).toBe(h.get("X-Conversation-Message-ID"))
  expect(h.get("X-Conversation-Request-ID")).toMatch(UUID7)
  expect(h.get("X-Root-Request-ID")).toBe(h.get("X-Conversation-Request-ID"))
  expect(h.get("X-Conversation-ID")).toMatch(UUID7)
  expect(h.get("baggage")).toBe(`buddyId=,buddyName=,codebuddy.session_id=${h.get("X-Conversation-ID")},codebuddy.conversation_request_id=${h.get("X-Conversation-Request-ID")}`)
})

test("a later step of one send keeps its ids, a new message takes another", () => {
  const first = new Headers()
  const later = new Headers()
  const next = new Headers()
  const chat = (content: string) => JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content }, { role: "assistant", content: "hi" }, { role: "user", content: "go on" }] })
  attend(first, chat("hello"), "")
  attend(later, chat("hello"), "")
  attend(next, chat("bye"), "")
  expect(later.get("X-Conversation-Request-ID")).toBe(first.get("X-Conversation-Request-ID"))
  expect(next.get("X-Conversation-Request-ID")).not.toBe(first.get("X-Conversation-Request-ID"))
  expect(later.get("X-Conversation-Message-ID")).not.toBe(first.get("X-Conversation-Message-ID"))
})

test("chatHeaders puts on the desktop client's own marks", () => {
  const h = new Headers()
  chatHeaders(h)
  expect(h.get("Accept")).toBe("application/json")
  expect(h.get("X-Agent-Type")).toBe("main")
  expect(h.get("X-Agent-Purpose")).toBe("conversation")
  expect(h.get("X-Agent-Intent")).toBe("craft")
  expect(h.get("X-Agent-Runtime")).toBe("local-agent")
  expect(h.get("X-Private-Data")).toBe("false")
  expect(h.get("X-Requested-With")).toBe("XMLHttpRequest")
  expect(h.get("x-codebuddy-request")).toBe("1")
  expect(h.get("acp-connection-id")).toMatch(UUID7)
  for (const k of ["x-stainless-lang", "x-stainless-package-version", "x-stainless-os", "x-stainless-arch", "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-retry-count"]) {
    expect(h.get(k)).toBeTruthy()
  }
  expect(h.get("x-stainless-os")).toBe(process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux")
  expect(h.get("x-stainless-arch")).toBe(process.arch)
})

test("attend opens one trace a turn, a span each request, spelled the client's three ways", () => {
  const chat = (content: string) => JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content }, { role: "assistant", content: "hi" }, { role: "user", content: "go on" }] })
  const first = new Headers()
  attend(first, chat("hello"), "")
  const traceparent = first.get("traceparent") ?? ""
  expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  const trace = first.get("X-B3-TraceId") ?? ""
  const span = first.get("X-B3-SpanId") ?? ""
  const parent = first.get("X-B3-ParentSpanId") ?? ""
  expect(traceparent).toBe(`00-${trace}-${span}-01`)
  expect(first.get("b3")).toBe(`${trace}-${span}-1-${parent}`)
  expect(first.get("X-B3-Sampled")).toBe("1")
  expect(first.get("X-Trace-ID")).toBe(trace)
  // the turn's later steps keep the trace and its parent, take a span each
  const step = new Headers()
  attend(step, chat("hello"), "")
  expect(step.get("X-B3-TraceId")).toBe(trace)
  expect(step.get("X-B3-ParentSpanId")).toBe(parent)
  expect(step.get("X-B3-SpanId")).not.toBe(span)
  // another send opens another trace
  const next = new Headers()
  attend(next, chat("bye"), "")
  expect(next.get("X-B3-TraceId")).not.toBe(trace)
})

test("a chat goes out with the whole of the client's headers", async () => {
  const h = await ask({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "hello" }] })
  const v = desktopVersion(SITES.workbuddy)
  expect(h.get("User-Agent")).toBe(`WorkBuddy/${v} WorkBuddy/${v} CLI/2.165.0`)
  expect(h.get("X-IDE-Version")).toBe(v)
  expect(h.get("X-Agent-Type")).toBe("main")
  expect(h.get("X-Agent-Purpose")).toBe("conversation")
  expect(h.get("X-Agent-Runtime")).toBe("local-agent")
  expect(h.get("X-Private-Data")).toBe("false")
  expect(h.get("X-Requested-With")).toBe("XMLHttpRequest")
  expect(h.get("x-codebuddy-request")).toBe("1")
  expect(h.get("Accept")).toBe("application/json")
  expect(h.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  expect(h.get("X-Conversation-Message-ID")).toMatch(UUID7)
  expect(h.get("X-Root-Request-ID")).toBe(h.get("X-Conversation-Request-ID"))
  expect(h.get("baggage")).toContain("codebuddy.session_id=")
  expect(h.get("Content-Encoding")).toBe("gzip")
  // the body itself is gzip bytes that gunzip back to the chat
  expect(lastBody instanceof Uint8Array).toBe(true)
  const unzipped = gunzipSync(lastBody as Uint8Array).toString()
  expect(JSON.parse(unzipped).model).toBe("glm-5.3")
  const again = await ask({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "again" }] })
  expect(again.get("acp-connection-id")).toBe(h.get("acp-connection-id"))
  expect(again.get("X-Conversation-ID")).not.toBe(h.get("X-Conversation-ID"))
})

test("desktopVersion says a version, read or measured", () => {
  expect(desktopVersion(SITES.workbuddy)).toMatch(/^\d+(\.\d+){2}/)
  expect(desktopVersion(SITES["workbuddy-ai"])).toMatch(/^\d+(\.\d+){2}/)
})
