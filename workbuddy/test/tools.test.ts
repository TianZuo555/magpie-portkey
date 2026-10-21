// WorkBuddy's models refuse tool schemas they can't pass on: DeepSeek and Kimi
// answer 400 11133 "Invalid request parameters" to some shapes, and a tool's
// name may only hold letters, digits, _ and -. Each shape below was refused on
// a real account and passes once mended as here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { _internal } from "../index.ts";

const { fitTools, renamed, normalizeToolChoice } = _internal;

const tool = (name: string, parameters: unknown) => ({ type: "function", function: { name, description: "d", parameters } });
const chat = (tools: unknown[], extra: Record<string, unknown> = {}) =>
  ({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], tools, ...extra }) as any;

const parameters = (schema: unknown) => {
  const body = chat([tool("t", schema)]);
  fitTools(body);
  return body.tools![0].function.parameters;
};
const property = (schema: unknown) => parameters({ type: "object", properties: { a: schema } }).properties.a;

test("a pattern's \\0 is sent as \\u0000, at any depth; \\\\0 and \\01 are left", () => {
  const out = parameters({
    type: "object",
    properties: {
      a: { type: "string", pattern: "^[^\\0]*$" },
      b: { type: "array", items: { type: "string", pattern: "x\\0" } },
      c: { type: "string", pattern: "\\\\0|\\01" },
    },
  });
  assert.equal(out.properties.a.pattern, "^[^\\u0000]*$");
  assert.equal(out.properties.b.items.pattern, "x\\u0000");
  assert.equal(out.properties.c.pattern, "\\\\0|\\01");
  assert.equal(new RegExp(out.properties.a.pattern).test("a\u0000b"), false);
  assert.equal(new RegExp(out.properties.a.pattern).test("ab"), true);
});

test("a root anyOf of objects becomes one object; a field each branch requires stays required", () => {
  const out = parameters({
    anyOf: [
      { type: "object", properties: { kind: { const: "a" }, x: { type: "string" } }, required: ["kind", "x"] },
      { type: "object", properties: { kind: { const: "b" }, y: { type: "number" } }, required: ["kind"] },
    ],
  });
  assert.equal(out.anyOf, undefined);
  assert.equal(out.type, "object");
  assert.deepEqual(Object.keys(out.properties).sort(), ["kind", "x", "y"]);
  assert.deepEqual(out.properties.kind, { anyOf: [{ const: "a" }, { const: "b" }] });
  assert.deepEqual(out.required, ["kind"]);
});

test("root allOf and $ref branches are merged", () => {
  const out = parameters({
    $defs: { A: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
    allOf: [{ $ref: "#/$defs/A" }, { type: "object", properties: { b: { type: "string" } } }],
  });
  assert.equal(out.allOf, undefined);
  assert.deepEqual(Object.keys(out.properties).sort(), ["a", "b"]);
  assert.deepEqual(out.required, ["a"]);
});

test("parameters with no type, or empty, are an object", () => {
  const body = chat([
    tool("a", { properties: { x: { type: "string" } } }),
    tool("b", {}),
    tool("c", null),
  ]);
  fitTools(body);
  assert.deepEqual(body.tools![0].function.parameters, { type: "object", properties: { x: { type: "string" } } });
  assert.deepEqual(body.tools![1].function.parameters, { type: "object", properties: {} });
  assert.deepEqual(body.tools![2].function.parameters, { type: "object", properties: {} });
});

test("a tuple's items become one schema", () => {
  const out = parameters({
    type: "object",
    properties: {
      p: { type: "array", items: [{ type: "number" }, { type: "string" }], additionalItems: false },
      q: { type: "array", items: [{ type: "number" }] },
    },
  });
  assert.deepEqual(out.properties.p, { type: "array", items: { anyOf: [{ type: "number" }, { type: "string" }] } });
  assert.deepEqual(out.properties.q.items, { type: "number" });
});

test("a clean chat is left as it came", () => {
  const body = chat([
    tool("mcp__node_repl__js", {
      type: "object",
      properties: { code: { type: "string", pattern: "^x" } },
      required: ["code"],
    }),
  ]);
  const before = JSON.stringify(body);
  assert.equal(fitTools(body).size, 0);
  assert.equal(JSON.stringify(body), before);
});

test("a name WorkBuddy refuses is sent safe, in the tools and the history, and kept apart", () => {
  const body = {
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "fs.read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
    tools: [
      tool("fs.read", { type: "object", properties: {} }),
      tool("fs_read", { type: "object", properties: {} }),
      tool("搜索", { type: "object", properties: {} }),
      tool("a/b c:d", { type: "object", properties: {} }),
    ],
  } as any;
  const names = fitTools(body);
  const sent = body.tools.map((t: any) => t.function.name);
  for (const name of sent) assert.match(name, /^[A-Za-z0-9_-]+$/);
  assert.equal(new Set(sent).size, 4);
  assert.equal(sent[1], "fs_read");
  assert.equal(names.get(sent[0]), "fs.read");
  assert.equal(names.get(sent[2]), "搜索");
  assert.equal(names.get(sent[3]), "a/b c:d");
  assert.equal(body.messages[1].tool_calls[0].function.name, sent[0]);
});

test("the model's calls come back under the client's names, streamed or not", async () => {
  const names = new Map([["fs_read_2", "fs.read"]]);
  const json = new Response(
    JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "c", function: { name: "fs_read_2", arguments: "{}" } }] } }] }),
    { headers: { "content-type": "application/json" } },
  );
  const value = await (await renamed(json, names)).json();
  assert.equal(value.choices[0].message.tool_calls[0].function.name, "fs.read");

  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "fs_read_2", arguments: "" } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] })}\n\ndata: [DONE]\n\n`,
  ].join("");
  // split mid-line, as the network does
  const encoder = new TextEncoder();
  const cut = 37;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse.slice(0, cut)));
      controller.enqueue(encoder.encode(sse.slice(cut)));
      controller.close();
    },
  });
  const text = await (await renamed(new Response(stream, { headers: { "content-type": "text/event-stream" } }), names)).text();
  assert.ok(text.includes('"name":"fs.read"'));
  assert.ok(!text.includes("fs_read_2"));
  assert.ok(text.includes("data: [DONE]"));
  assert.equal(text.split("data:").length, sse.split("data:").length);
});

test("an enum with no type takes its values' type, or that and null", () => {
  assert.deepEqual(property({ enum: ["x", "y"], description: "d" }), { enum: ["x", "y"], description: "d", type: "string" });
  assert.deepEqual(property({ enum: [1, 2] }), { enum: [1, 2], type: "integer" });
  assert.deepEqual(property({ enum: [1, 2.5] }), { enum: [1, 2.5], type: "number" });
  assert.deepEqual(property({ enum: [true, null] }), { enum: [true, null], type: ["boolean", "null"] });
  assert.deepEqual(property({ enum: [null] }), { enum: [null], type: "null" });
  assert.equal(property({ type: "array", items: { enum: ["a"] } }).items.type, "string");
  assert.equal(property({ anyOf: [{ enum: ["a"] }, { type: "integer" }] }).anyOf[0].type, "string");
  assert.equal(parameters({ type: "object", properties: {}, $defs: { x: { enum: ["a"] } } }).$defs.x.type, "string");
});

test("an enum of several types is an anyOf of an enum for each", () => {
  const split = [{ type: "string", enum: ["x"] }, { type: "integer", enum: [1] }, { type: "null" }];
  assert.deepEqual(property({ enum: ["x", 1, null], description: "d" }), { description: "d", anyOf: split });
  assert.deepEqual(property({ type: ["string", "integer", "null"], enum: ["x", 1, null] }), { anyOf: split });
  assert.deepEqual(property({ anyOf: [{ minLength: 1 }], enum: ["x", 1] }), {
    anyOf: [{ minLength: 1 }],
    allOf: [{ anyOf: split.slice(0, 2) }],
  });
});

test("an enum WorkBuddy takes is left as it came", () => {
  for (const schema of [
    { type: "string", enum: ["a"] },
    { type: ["integer", "null"], enum: [1, null] },
    { type: ["null", "string"], enum: [null, "a"] },
    { type: "null", enum: [null] },
    { type: "string", enum: [1] },
  ]) {
    assert.deepEqual(property(structuredClone(schema)), schema);
  }
});

test("an empty enum, a required that isn't a list, and a type WorkBuddy doesn't know are left out", () => {
  assert.deepEqual(property({ type: "string", enum: [] }), { type: "string" });
  assert.deepEqual(property({ type: "object", properties: { x: { type: "string" } }, required: "x" }), {
    type: "object",
    properties: { x: { type: "string" } },
  });
  assert.deepEqual(property({ type: "String" }), { type: "string" });
  assert.deepEqual(property({ type: "any" }), {});
  assert.deepEqual(property({ type: ["Integer", "foo", "null"] }), { type: ["integer", "null"] });
});

test("true and false where a schema goes are {} and {not: {}}; additionalProperties is left", () => {
  const out = parameters({
    type: "object",
    additionalProperties: false,
    properties: {
      a: true,
      b: false,
      c: { type: "array", items: true },
      d: { type: "object", additionalProperties: true },
    },
  });
  assert.deepEqual(out.properties, {
    a: {},
    b: { not: {} },
    c: { type: "array", items: {} },
    d: { type: "object", additionalProperties: true },
  });
  assert.equal(out.additionalProperties, false);
});

test("a property named enum, type or required is a name, not a keyword", () => {
  const schema = {
    type: "object",
    properties: { enum: { type: "string" }, type: { type: "string", enum: ["a"] }, required: { type: "boolean" } },
    required: ["enum"],
  };
  const body = chat([tool("t", structuredClone(schema))]);
  const before = JSON.stringify(body);
  fitTools(body);
  assert.equal(JSON.stringify(body), before);
});

test("tool_choice follows the name the tool was given", () => {
  const body = chat([tool("fs.read", { type: "object" })], {
    tool_choice: { type: "function", function: { name: "fs.read" } },
  });
  fitTools(body);
  normalizeToolChoice(body);
  const sent = body.tools![0].function.name;
  assert.equal(body.tool_choice, sent);
  assert.notEqual(body.tool_choice, "fs.read");

  const auto = chat([], { tool_choice: { type: "auto" } });
  normalizeToolChoice(auto);
  assert.equal(auto.tool_choice, "auto");

  const none = chat([], { tool_choice: { type: "none" }, tools: [tool("x", {})] });
  normalizeToolChoice(none);
  assert.equal(none.tool_choice, undefined);
  assert.equal(none.tools, undefined);
});
