import { setFetch, parse, chatFetch, type Call, type Save } from "./test-helpers.ts"
import type { Account, Client, MagpiePlugin, WireRecord } from "./types.ts"
// WorkBuddy AI answers 400 "Invalid request parameters" (11133) to a chat
// whose tools its model turns away: wyh's ZCode and DeepSeek Harness on
// deepseek-v4.1-flash. Each shape below was refused on the owner's account
// (2026-10-08) and passed once mended as here.
import { expect, test } from "bun:test"
import { _internal } from "./index.ts"

const { fitted, fitTools, renamed } = _internal

const tool = (name, parameters) => ({ type: "function", function: { name, description: "d", parameters } })
const chat = (tools, extra = {}) => JSON.stringify({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], tools, ...extra })

test("a pattern's \\0 is sent as \\u0000, at any depth; \\\\0 and \\01 are left", () => {
  const body = chat([tool("t", { type: "object", properties: {
    a: { type: "string", pattern: "^[^\\0]*$" },
    b: { type: "array", items: { type: "string", pattern: "x\\0" } },
    c: { type: "string", pattern: "\\\\0|\\01" },
  } })])
  const b = parse(fitted(body).body)
  const ps = b.tools[0].function.parameters
  expect(ps.properties.a.pattern).toBe("^[^\\u0000]*$")
  expect(ps.properties.b.items.pattern).toBe("x\\u0000")
  expect(ps.properties.c.pattern).toBe("\\\\0|\\01")
  expect(new RegExp(ps.properties.a.pattern).test("a\u0000b")).toBe(false)
  expect(new RegExp(ps.properties.a.pattern).test("ab")).toBe(true)
})

test("a root anyOf of objects becomes one object; a field each branch requires stays required", () => {
  const body = chat([tool("t", { anyOf: [
    { type: "object", properties: { kind: { const: "a" }, x: { type: "string" } }, required: ["kind", "x"] },
    { type: "object", properties: { kind: { const: "b" }, y: { type: "number" } }, required: ["kind"] },
  ] })])
  const ps = parse(fitted(body).body).tools[0].function.parameters
  expect(ps.anyOf).toBeUndefined()
  expect(ps.type).toBe("object")
  expect(Object.keys(ps.properties).sort()).toEqual(["kind", "x", "y"])
  expect(ps.properties.kind).toEqual({ anyOf: [{ const: "a" }, { const: "b" }] })
  expect(ps.required).toEqual(["kind"])
})

test("root allOf and $ref branches are merged", () => {
  const body = chat([tool("t", { $defs: { A: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } }, allOf: [{ $ref: "#/$defs/A" }, { type: "object", properties: { b: { type: "string" } } }] })])
  const ps = parse(fitted(body).body).tools[0].function.parameters
  expect(ps.allOf).toBeUndefined()
  expect(Object.keys(ps.properties).sort()).toEqual(["a", "b"])
  expect(ps.required).toEqual(["a"])
})

test("parameters with no type, or empty, are an object", () => {
  const body = chat([tool("a", { properties: { x: { type: "string" } } }), tool("b", {}), tool("c", null)])
  const tools = parse(fitted(body).body).tools
  expect(tools[0].function.parameters).toEqual({ type: "object", properties: { x: { type: "string" } } })
  expect(tools[1].function.parameters).toEqual({ type: "object", properties: {} })
  expect(tools[2].function.parameters).toEqual({ type: "object", properties: {} })
})

test("a tuple's items become one schema", () => {
  const body = chat([tool("t", { type: "object", properties: { p: { type: "array", items: [{ type: "number" }, { type: "string" }], additionalItems: false }, q: { type: "array", items: [{ type: "number" }] } } })])
  const ps = parse(fitted(body).body).tools[0].function.parameters
  expect(ps.properties.p).toEqual({ type: "array", items: { anyOf: [{ type: "number" }, { type: "string" }] } })
  expect(ps.properties.q.items).toEqual({ type: "number" })
})

test("a clean chat is the same bytes", () => {
  const body = chat([tool("mcp__node_repl__js", { type: "object", properties: { code: { type: "string", pattern: "^x" } }, required: ["code"] })])
  const out = fitted(body)
  expect(out.body).toBe(body)
  expect(out.names.size).toBe(0)
  const plain = JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
  expect(fitted(plain).body).toBe(plain)
})

test("a name WorkBuddy refuses is sent safe, in the tools and the history, and kept apart", () => {
  const b = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "fs.read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
    tools: [tool("fs.read", { type: "object", properties: {} }), tool("fs_read", { type: "object", properties: {} }), tool("搜索", { type: "object", properties: {} }), tool("a/b c:d", { type: "object", properties: {} })],
  }
  const { changed, names } = fitTools(b)
  expect(changed).toBe(true)
  const sent = b.tools.map((t) => t.function.name)
  for (const n of sent) expect(n).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(new Set(sent).size).toBe(4)
  expect(sent[1]).toBe("fs_read")
  expect(names.get(sent[0])).toBe("fs.read")
  expect(names.get(sent[2])).toBe("搜索")
  expect(names.get(sent[3])).toBe("a/b c:d")
  expect(b.messages[1].tool_calls[0].function.name).toBe(sent[0])
})

test("the model's calls come back under the client's names, streamed or not", async () => {
  const names = new Map([["fs_read_2", "fs.read"]])
  const one = new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "fs_read_2", arguments: "{}" } }] } }] }), { headers: { "content-type": "application/json" } })
  const v = await (await renamed(one, names)).json()
  expect(v.choices[0].message.tool_calls[0].function.name).toBe("fs.read")

  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "fs_read_2", arguments: "" } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] })}\n\ndata: [DONE]\n\n`,
  ].join("")
  // split mid-line, as the network does
  const enc = new TextEncoder()
  const cut = 37
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(sse.slice(0, cut)))
      c.enqueue(enc.encode(sse.slice(cut)))
      c.close()
    },
  })
  const text = await (await renamed(new Response(stream, { headers: { "content-type": "text/event-stream" } }), names)).text()
  expect(text).toContain('"name":"fs.read"')
  expect(text).not.toContain("fs_read_2")
  expect(text).toContain("data: [DONE]")
  expect(text.split("data:").length).toBe(sse.split("data:").length)
})

// clearmann (#122): Kimi (kimi-k3-1) answers 11133 to an MCP server's
// tools. Each shape below was refused on the owner's account (2026-10-14)
// and passed once mended as here, on Kimi, DeepSeek (11129 before) and
// GLM; MiniMax and Hunyuan took both.
const params = (ps) => parse(fitted(chat([tool("t", ps)])).body).tools[0].function.parameters
const prop = (p) => params({ type: "object", properties: { a: p } }).properties.a

test("an enum with no type takes its values' type, or that and null", () => {
  expect(prop({ enum: ["x", "y"], description: "d" })).toEqual({ enum: ["x", "y"], description: "d", type: "string" })
  expect(prop({ enum: [1, 2] })).toEqual({ enum: [1, 2], type: "integer" })
  expect(prop({ enum: [1, 2.5] })).toEqual({ enum: [1, 2.5], type: "number" })
  expect(prop({ enum: [true, null] })).toEqual({ enum: [true, null], type: ["boolean", "null"] })
  expect(prop({ enum: [null] })).toEqual({ enum: [null], type: "null" })
  // under items, anyOf and an unused $defs alike
  expect(prop({ type: "array", items: { enum: ["a"] } }).items.type).toBe("string")
  expect(prop({ anyOf: [{ enum: ["a"] }, { type: "integer" }] }).anyOf[0].type).toBe("string")
  expect(params({ type: "object", properties: {}, $defs: { x: { enum: ["a"] } } }).$defs.x.type).toBe("string")
})

test("an enum of several types is an anyOf of an enum for each, typed or not", () => {
  const split = [{ type: "string", enum: ["x"] }, { type: "integer", enum: [1] }, { type: "null" }]
  expect(prop({ enum: ["x", 1, null], description: "d" })).toEqual({ description: "d", anyOf: split })
  expect(prop({ type: ["string", "integer", "null"], enum: ["x", 1, null] })).toEqual({ anyOf: split })
  expect(prop({ anyOf: [{ minLength: 1 }], enum: ["x", 1] })).toEqual({ anyOf: [{ minLength: 1 }], allOf: [{ anyOf: split.slice(0, 2) }] })
})

test("an enum Kimi takes is left: typed T, or T and null", () => {
  for (const p of [{ type: "string", enum: ["a"] }, { type: ["integer", "null"], enum: [1, null] }, { type: ["null", "string"], enum: [null, "a"] }, { type: "null", enum: [null] }, { type: "string", enum: [1] }]) {
    expect(prop(structuredClone(p))).toEqual(p)
  }
})

test("an empty enum, a required that isn't a list, and a type Kimi doesn't know are left out", () => {
  expect(prop({ type: "string", enum: [] })).toEqual({ type: "string" })
  expect(prop({ type: "object", properties: { x: { type: "string" } }, required: "x" })).toEqual({ type: "object", properties: { x: { type: "string" } } })
  expect(prop({ type: "String" })).toEqual({ type: "string" })
  expect(prop({ type: "any" })).toEqual({})
  expect(prop({ type: ["Integer", "foo", "null"] })).toEqual({ type: ["integer", "null"] })
})

test("true and false where a schema goes are {} and {not: {}}; additionalProperties is left", () => {
  const ps = params({ type: "object", additionalProperties: false, properties: { a: true, b: false, c: { type: "array", items: true }, d: { type: "object", additionalProperties: true } } })
  expect(ps.properties).toEqual({ a: {}, b: { not: {} }, c: { type: "array", items: {} }, d: { type: "object", additionalProperties: true } })
  expect(ps.additionalProperties).toBe(false)
})

test("a property named enum, type or required is a name, not a keyword", () => {
  const p = { type: "object", properties: { enum: { type: "string" }, type: { type: "string", enum: ["a"] }, required: { type: "boolean" } }, required: ["enum"] }
  const body = chat([tool("t", structuredClone(p))])
  expect(fitted(body).body).toBe(body)
})

// Kimi K3.1 Pro answers 400 "Invalid request parameters" to a oneOf with no
// type, even of objects only, and takes it with "type": "object" beside it
// (congee949, #378). The parameters below are the issue's own.
const ab = [
  { type: "object", properties: { mode: { type: "string", const: "a" } } },
  { type: "object", properties: { mode: { type: "string", const: "b" } } },
]

test("a $ref's target that is a oneOf of objects with no type is typed object", () => {
  const body = JSON.stringify({ model: "kimi-k3.1-pro", messages: [{ role: "user", content: "Do not call tools. Reply exactly OK." }], tools: [{ type: "function", function: { name: "probe", description: "Diagnostic placeholder.", parameters: { type: "object", properties: { x: { $ref: "#/$defs/X" } }, $defs: { X: { oneOf: ab } } } } }] })
  const ps = JSON.parse(fitted(body).body as string).tools[0].function.parameters
  expect(ps.$defs.X).toEqual({ oneOf: ab, type: "object" })
  expect(ps.properties.x).toEqual({ $ref: "#/$defs/X" })
})

test("a oneOf of objects inside a $ref's target, and one whose branches are $refs to objects, are typed object", () => {
  const ps: any = { type: "object", properties: { x: { $ref: "#/$defs/X" } }, $defs: { X: { type: "object", properties: { y: { oneOf: ab } }, required: ["y"] } } }
  expect(_internal.typeUnions(ps)).toBe(true)
  expect(ps.$defs.X.properties.y.type).toBe("object")
  const refs: any = { type: "object", properties: { s: { $ref: "#/$defs/__schema0" } }, $defs: { __schema0: { oneOf: [{ $ref: "#/$defs/__schema1" }, { $ref: "#/$defs/__schema3" }] }, __schema1: { type: "object", properties: { launch: { type: "boolean" } } }, __schema2: { $ref: "#/$defs/__schema1" }, __schema3: { $ref: "#/$defs/__schema4" }, __schema4: { type: "object", properties: { connect: { type: "string" } } } } }
  expect(_internal.typeUnions(refs)).toBe(true)
  expect(refs.$defs.__schema0.type).toBe("object")
  expect(refs.$defs.__schema2.type).toBeUndefined()
})

test("a oneOf that is typed, mixed, an anyOf, or reaches a missing, external or circular $ref is left", () => {
  const ps: any = { type: "object", properties: {
    typed: { type: "object", oneOf: ab },
    mixed: { oneOf: [ab[0], { type: "string" }] },
    any: { anyOf: ab },
    missing: { oneOf: [ab[0], { $ref: "#/$defs/Nope" }] },
    external: { oneOf: [ab[0], { $ref: "other.json#/X" }] },
    loop: { oneOf: [ab[0], { $ref: "#/$defs/A" }] },
    examples: { type: "array", examples: [{ oneOf: ab }] },
  }, $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } } }
  const before = structuredClone(ps)
  expect(_internal.typeUnions(ps)).toBe(false)
  expect(ps).toEqual(before)
})
