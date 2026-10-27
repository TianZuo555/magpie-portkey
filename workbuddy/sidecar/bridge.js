// The WorkBuddy bridge: a sidecar Node (22.21.1, as the desktop's own
// x-stainless marks say its client runs) that the magpie plugin's requests
// go out through. The wire's TLS fingerprint is the host's — the plugin
// runs under Bun, whose handshake is not Node's — so the plugin sends its
// requests here (plain HTTP on the loopback, the real target in a header)
// and this Node carries them out with its own TLS, streaming answers —
// WorkBuddy's chats are SSE — back as they arrive.
//
// The protocol:
//   GET  /health   -> 200 "ok"
//   POST /forward  -> x-wb-bridge-target: <absolute https url>
//                     every other header and the body go to it as they are
//                     (the body already gzipped stays gzipped), the answer
//                     streams back with its length and encoding headers
//                     redone, for Node has decompressed it.
const http = require("node:http")
const { Readable } = require("node:stream")

const PORT = Number(process.env.WORKBUDDY_BRIDGE_PORT || 18765)
const HOP = ["x-wb-bridge-target", "host", "content-length", "connection", "accept-encoding"]

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" })
    return res.end("ok")
  }
  if (req.url !== "/forward") {
    res.writeHead(404, { "content-type": "application/json" })
    return res.end(JSON.stringify({ ok: false, error: "Not Found" }))
  }
  const target = req.headers["x-wb-bridge-target"]
  if (typeof target !== "string" || !/^https:\/\//.test(target)) {
    res.writeHead(400, { "content-type": "application/json" })
    return res.end(JSON.stringify({ ok: false, error: "no https target" }))
  }
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const headers = { ...req.headers }
  for (const k of HOP) delete headers[k]
  const t0 = Date.now()
  try {
    const up = await fetch(target, { method: req.method, headers, body: body.length ? body : undefined })
    const out = {}
    up.headers.forEach((v, k) => {
      if (k !== "content-encoding" && k !== "content-length" && k !== "transfer-encoding") out[k] = v
    })
    res.writeHead(up.status, out)
    res.flushHeaders()
    if (up.body) Readable.fromWeb(up.body).pipe(res)
    else res.end()
    console.log(new Date().toISOString(), req.method, new URL(target).host + new URL(target).pathname, "->", up.status, `${Date.now() - t0}ms`)
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" })
    res.end("bridge: " + String(e).slice(0, 200))
    console.log(new Date().toISOString(), "forward failed:", String(e).slice(0, 120))
  }
})

server.listen(PORT, "127.0.0.1", () => console.log(new Date().toISOString(), `bridge on 127.0.0.1:${PORT}, node ${process.version}`))
