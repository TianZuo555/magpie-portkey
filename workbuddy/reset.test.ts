import { setFetch, parse, chatFetch, type Call, type Save } from "./test-helpers.ts"
import type { Account, Client, MagpiePlugin, WireRecord } from "./types.ts"
// WorkBuddy's front door answers a sign-in it refuses with 401, but only
// for a request of up to 2 MiB: past that it resets the connection, and a
// long Claude Code session's every turn failed as ECONNRESET (wyp on
// Discord, 2026-10-15). The fake below is that front door on a real
// socket, so Bun's fetch meets the same reset it met on www.workbuddy.ai.
import { afterAll, beforeAll, expect, test } from "bun:test"
import net from "node:net"
import { randomBytes } from "node:crypto"
import { WorkBuddyAIAuthPlugin, WorkBuddyAuthPlugin, _internal } from "./index.ts"

const { EDGE_READS } = _internal
const GOOD = "Bearer good"

let server
let origin
let meterAsked = 0
let resetAll = false // a reset that isn't the sign-in's: every long body

beforeAll(async () => {
  server = net.createServer((s) => {
    let buf = Buffer.alloc(0)
    let head = null
    s.on("error", () => {})
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (!head) {
        const end = buf.indexOf("\r\n\r\n")
        if (end < 0) return
        const lines = buf.subarray(0, end).toString("latin1").split("\r\n")
        const h = Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]))
        head = { path: lines[0].split(" ")[1], auth: h.authorization, length: Number(h["content-length"] ?? 0) }
        buf = buf.subarray(end + 4)
      }
      const refused = head.auth !== GOOD
      if (head.length > EDGE_READS && (refused || resetAll)) {
        // the front door reads its 2 MiB, then drops the connection unanswered
        if (buf.length > EDGE_READS) s.resetAndDestroy()
        return
      }
      if (buf.length < head.length) return
      const { path } = head
      head = null
      buf = Buffer.alloc(0)
      if (path.startsWith("/billing/")) meterAsked++
      if (refused) {
        const html = "<html><head><title>401 Authorization Required</title></head></html>"
        s.end(`HTTP/1.1 401 Unauthorized\r\ncontent-type: text/html\r\ncontent-length: ${html.length}\r\nconnection: close\r\n\r\n${html}`)
        return
      }
      const body = path.startsWith("/billing/") ? '{"code":0,"msg":"OK","data":{}}' : 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n'
      s.end(`HTTP/1.1 200 OK\r\ncontent-type: ${path.startsWith("/billing/") ? "application/json" : "text/event-stream"}\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`)
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  origin = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => server.close())

// chat is a loader fetch of a body of about size bytes on the wire, signed
// in as token, with the site (WorkBuddy AI's, else the China build's) served
// by the fake. The body is random hex asked twice over, for gzip composes
// hex down to about half — the wire stays past the edge the fake reads.
async function chat(token, size, plugin = WorkBuddyAIAuthPlugin, site = "https://www.workbuddy.ai") {
  const realFetch = globalThis.fetch
  setFetch((u, init) => realFetch(String(u instanceof Request ? u.url : u).replace(site, origin), init))
  try {
    const hooks = await plugin({ client: {} })
    const loader = await hooks.auth.loader(async () => ({ type: "oauth", access: token, uid: "uid", expires: Date.now() + 3600_000 }))
    const body = JSON.stringify({
      model: "fast-model",
      stream: true,
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: randomBytes(size).toString("hex") },
      ],
    })
    return await chatFetch(loader)(site + "/v2/chat/completions", { method: "POST", body })
  } finally {
    setFetch(realFetch)
  }
}

test("a refused sign-in on a chat past 2 MiB says the 401, not ECONNRESET", async () => {
  meterAsked = 0
  const res = await chat("refused", EDGE_READS + 100_000)
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  const { error } = await res.json()
  expect(error.message).toContain("refused this account's sign-in (401)")
  expect(error.message).toContain("which is why it read as ECONNRESET")
  expect(error.message).toContain("Sign in to it again in magpie")
  expect(meterAsked).toBe(1)
})

test("the China build's front door is read the same way", async () => {
  meterAsked = 0
  const res = await chat("refused", EDGE_READS + 100_000, WorkBuddyAuthPlugin, "https://copilot.tencent.com")
  expect(res.status).toBe(401)
  expect((await res.json()).error.message).toContain("Providers → WorkBuddy →")
  expect(meterAsked).toBe(1)
})

test("a refused sign-in on a short chat is the front door's own 401, nothing else asked", async () => {
  meterAsked = 0
  const res = await chat("refused", 1000)
  expect(res.status).toBe(401)
  // with no refresh token to renew it with, said so (unauthorized.test.ts)
  expect((await res.json()).error.message).toContain("there is no refresh token to renew it with")
  expect(meterAsked).toBe(0)
})

test("a reset past 2 MiB with the sign-in accepted stays the reset", async () => {
  meterAsked = 0
  resetAll = true
  try {
    let err
    await chat("good", EDGE_READS + 100_000).catch((e) => (err = e))
    expect(err?.code).toBe("ECONNRESET")
    expect(meterAsked).toBe(1)
  } finally {
    resetAll = false
  }
})

test("an accepted sign-in's chat past 2 MiB goes through", async () => {
  meterAsked = 0
  const res = await chat(GOOD.slice(7), EDGE_READS + 100_000)
  expect(res.status).toBe(200)
  expect(await res.text()).toContain("pong")
  expect(meterAsked).toBe(0)
})
