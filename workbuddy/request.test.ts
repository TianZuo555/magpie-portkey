import { setFetch, parse, chatFetch, type Call, type Save } from "./test-helpers.ts"
import type { Account, Client, MagpiePlugin, WireRecord } from "./types.ts"
// WorkBuddy's international chat endpoint uses a narrower OpenAI-compatible
// request shape than pi-ai's default Chat Completions payload.
import { expect, test } from "bun:test"
import { WorkBuddyAIAuthPlugin, _internal } from "./index.ts"

const { withSystem, normalizeToolChoice, fitted } = _internal

test("normalizes pi-ai output limits and developer messages", () => {
  const body = JSON.stringify({
    model: "gpt-6.1-sol",
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    max_completion_tokens: 128000,
    reasoning_effort: "high",
    messages: [
      { role: "developer", content: "You are a coding assistant." },
      { role: "user", content: "Reply with exactly OK." },
    ],
  })

  const out = parse(withSystem(body))
  expect(out.max_tokens).toBe(128000)
  expect(out.max_completion_tokens).toBeUndefined()
  expect(out.messages[0]).toEqual({ role: "system", content: "You are a coding assistant." })
  expect(out.messages[1]).toEqual({ role: "user", content: "Reply with exactly OK." })
})

test("flattens tool_choice after tool names are made safe", () => {
  const body = JSON.stringify({
    messages: [{ role: "user", content: "run it" }],
    tools: [{
      type: "function",
      function: { name: "fs.read", description: "Read a file", parameters: { type: "object" } },
    }],
    tool_choice: { type: "function", function: { name: "fs.read" } },
  })
  const fit = fitted(body)
  const out = parse(normalizeToolChoice(fit.body))

  expect(out.tools[0].function.name).toBe("fs_read")
  expect(out.tool_choice).toBe("fs_read")
})

test("removes tools when tool_choice is none", () => {
  const body = JSON.stringify({
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    tool_choice: { type: "none" },
  })
  const out = parse(normalizeToolChoice(body))

  expect(out.tool_choice).toBeUndefined()
  expect(out.tools).toBeUndefined()
})

test("loader sends the normalized body to WorkBuddy", async () => {
  const realFetch = globalThis.fetch
  let sent
  setFetch(async (_url, init) => {
    sent = parse(init.body)
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  })
  try {
    const hooks = await WorkBuddyAIAuthPlugin({ client: {} })
    const loader = await hooks.auth.loader(async () => ({
      type: "oauth",
      access: "access",
      uid: "uid",
      expires: Date.now() + 3600_000,
    }))
    const response = await chatFetch(loader)("https://www.workbuddy.ai/v2/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-6.1-sol",
        max_completion_tokens: 128000,
        reasoning_effort: "high",
        messages: [
          { role: "developer", content: "You are helpful." },
          { role: "user", content: "run it" },
        ],
        tools: [{ type: "function", function: { name: "fs.read", parameters: { type: "object" } } }],
        tool_choice: { type: "function", function: { name: "fs.read" } },
      }),
    })

    expect(response.status).toBe(200)
    expect(sent.max_tokens).toBe(128000)
    expect(sent.max_completion_tokens).toBeUndefined()
    expect(sent.messages[0].role).toBe("system")
    expect(sent.tools[0].function.name).toBe("fs_read")
    expect(sent.tool_choice).toBe("fs_read")
  } finally {
    setFetch(realFetch)
  }
})
