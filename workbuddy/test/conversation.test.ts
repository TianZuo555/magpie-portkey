// One user send is one request to WorkBuddy's backend, whatever it takes: every
// step of it carries the same X-Conversation-Request-ID, and the user's next
// message carries another. A conversation's turns share its
// X-Conversation-ID, from pi's session id, else from the chat's first user
// message; each request has a message id of its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { _internal } from "../index.ts";

const { SITES, attend, turnKey, conversationKey, signatureOf } = _internal;

const HEX32 = /^[0-9a-f]{32}$/;
const system = { role: "system", content: "be brief" };
const chat = (...messages: unknown[]) => ({ model: "glm-5.3", messages }) as any;
const send = (text: string) => chat(system, { role: "user", content: text });
const later = (first: string, text: string) =>
  chat(system, { role: "user", content: first }, { role: "assistant", content: "hi" }, { role: "user", content: text });
const call = {
  role: "assistant",
  content: null,
  tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
};
const result = { role: "tool", tool_call_id: "c1", content: "a.go" };

function headersOf(body: any, session = "") {
  const headers = new Headers();
  attend(headers, body, session);
  return headers;
}

test("one send's steps carry one turn id; the user's next message another", () => {
  const asked = headersOf(send("跑一下"));
  const called = headersOf(chat(system, { role: "user", content: "跑一下" }, call));
  const answered = headersOf(chat(system, { role: "user", content: "跑一下" }, call, result));
  const ids = [asked, called, answered].map((h) => h.get("x-conversation-request-id"));
  assert.match(ids[0]!, HEX32);
  assert.equal(new Set(ids).size, 1);
  // the user's next message is another turn
  assert.notEqual(headersOf(later("跑一下", "再来一次")).get("x-conversation-request-id"), ids[0]);
  // the same words asked again later are a turn of their own too: the place of
  // the message is part of the key
  assert.notEqual(
    headersOf(
      chat(system, { role: "user", content: "跑一下" }, { role: "assistant", content: "hi" }, { role: "user", content: "跑一下" }),
    ).get("x-conversation-request-id"),
    ids[0],
  );
  // the message's id is its own on each request, and is the request's id
  const messages = [asked, called, answered].map((h) => h.get("x-conversation-message-id"));
  assert.equal(new Set(messages).size, 3);
  for (const headers of [asked, called, answered]) {
    assert.equal(headers.get("x-conversation-message-id"), headers.get("x-request-id"));
  }
});

test("a conversation's turns share one id, named by pi's session", () => {
  const one = headersOf(send("fix the bug"), "session-1");
  const two = headersOf(later("fix the bug", "and then?"), "session-1");
  assert.match(one.get("x-conversation-id")!, HEX32);
  assert.equal(two.get("x-conversation-id"), one.get("x-conversation-id"));
  // another session is another conversation, the same words or not
  const other = headersOf(send("fix the bug"), "session-2");
  assert.notEqual(other.get("x-conversation-id"), one.get("x-conversation-id"));
});

test("with no session, the first user message names the conversation", () => {
  const one = headersOf(send("hi"));
  const two = headersOf(chat(system, { role: "user", content: "hi" }, { role: "assistant", content: "hi" }, call, result));
  assert.equal(conversationKey(send("hi"), ""), conversationKey(chat(system, { role: "user", content: "hi" }, call), ""));
  assert.equal(two.get("x-conversation-id"), one.get("x-conversation-id"));
  // another first message is another conversation
  assert.notEqual(headersOf(send("hello")).get("x-conversation-id"), one.get("x-conversation-id"));
});

test("a conversation id already set — by another plugin — is kept", () => {
  const headers = new Headers({ "X-Conversation-ID": "kept" });
  attend(headers, send("hi"), "session-1");
  assert.equal(headers.get("x-conversation-id"), "kept");
  assert.match(headers.get("x-conversation-request-id")!, HEX32);
});

test("a chat with no user message sends no conversation id", () => {
  const headers = headersOf(chat(system, { role: "assistant", content: "hi" }));
  assert.equal(headers.get("x-conversation-id"), null);
  // but a turn and a message id are still its own
  assert.match(headers.get("x-conversation-request-id")!, HEX32);
  assert.match(headers.get("x-conversation-message-id")!, HEX32);
});

test("a tool result's images in a user message are not a user send", () => {
  const withImages = chat(
    system,
    { role: "user", content: "look" },
    call,
    result,
    { role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image_url", image_url: { url: "data:," } }] },
  );
  // the turn is the user's own message, not what answering it added
  assert.equal(turnKey(withImages), turnKey(chat(system, { role: "user", content: "look" }, call, result)));
});

test("a signature is a message's text and a digest of what isn't text", () => {
  assert.equal(signatureOf("hi"), "hi");
  assert.equal(signatureOf([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  const image = [{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "data:," } }];
  assert.match(signatureOf(image), /^a\[image_url:[0-9a-f]{8}\]$/);
  // a tool result's part is left out: it changes with every step of a send
  assert.equal(signatureOf([{ type: "text", text: "a" }, { type: "tool_result", content: "x" }]), "a");
  assert.equal(signatureOf(undefined), "");
});

test("the ids are the same for one chat and differ for the next", () => {
  const site = SITES.workbuddy;
  const first = new Headers();
  attend(first, send("hi"), "s1");
  const second = new Headers();
  attend(second, send("hi"), "s1");
  // a message id per request; the turn's and the conversation's the same
  assert.notEqual(first.get("x-conversation-message-id"), second.get("x-conversation-message-id"));
  assert.equal(first.get("x-conversation-request-id"), second.get("x-conversation-request-id"));
  assert.equal(first.get("x-conversation-id"), second.get("x-conversation-id"));
  assert.equal(site.id, "workbuddy");
});
