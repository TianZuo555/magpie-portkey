// The words WorkBuddy refuses a chat for, "Illegal API invocation from an
// unapproved channel": withSystem puts words that pass in their place, in
// every message, and gives a chat with no system message WorkBuddy's own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { _internal } from "../index.ts";

const { withSystem, unflagged } = _internal;

const body = (messages: unknown[], extra: Record<string, unknown> = {}) =>
  ({ model: "glm-5.3", messages, ...extra }) as any;

test("each flagged phrase is put in other words, whatever its case", () => {
  assert.equal(
    unflagged("You are Claude Code, Anthropic’s official CLI for Claude."),
    "You are Claude Code, Anthropic's CLI for Claude.",
  );
  assert.equal(
    unflagged("Main branch (you will usually use this for PRs): main"),
    "Main branch (usually the base for PRs): main",
  );
  const codex =
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. Be precise.";
  assert.equal(unflagged(codex), codex.replace("Codex CLI is an open", "The Codex CLI is an open"));
  assert.equal(unflagged(unflagged(codex)), unflagged(codex));
  assert.equal(unflagged("nothing to see"), "nothing to see");
  assert.equal(
    unflagged("You are an AI agent that helps the user with programming tasks. Be brief."),
    "You are an AI agent that helps the user with programming tasks. Be brief.",
  );
  // "the Codex CLI is…" already says it the way WorkBuddy takes
  assert.equal(unflagged("the Codex CLI is an open source project"), "the Codex CLI is an open source project");
});

test("Claude Code's request passes: the header block goes, the rest is rewritten", () => {
  const out = withSystem(
    body([
      { role: "system", content: [{ type: "text", text: "        " }] },
      {
        role: "user",
        content: [
          { type: "text", text: "gitStatus\nMain branch (you will usually use this for PRs): main" },
          { type: "image_url", image_url: { url: "data:," } },
        ],
      },
    ]),
  );
  assert.deepEqual(out.messages![0], { role: "system", content: "You are a helpful assistant." });
  const parts = out.messages![1].content as any[];
  assert.equal(parts[0].text, "gitStatus\nMain branch (usually the base for PRs): main");
  assert.deepEqual(parts[1], { type: "image_url", image_url: { url: "data:," } });
});

test("a chat with no system message opens with WorkBuddy's default one", () => {
  const out = withSystem(body([{ role: "user", content: "hi" }]));
  assert.deepEqual(out.messages, [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "hi" },
  ]);
});

test("a chat with nothing flagged is sent as it came", () => {
  const input = body([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]);
  assert.deepEqual(withSystem(input), input);
});

test("pi's output limit and developer messages become what WorkBuddy takes", () => {
  const out = withSystem(
    body(
      [
        { role: "developer", content: "You are a coding assistant." },
        { role: "user", content: "Reply with exactly OK." },
      ],
      { max_completion_tokens: 128_000, max_tokens: undefined },
    ),
  );
  assert.equal(out.max_tokens, 128_000);
  assert.equal(out.max_completion_tokens, undefined);
  assert.deepEqual(out.messages![0], { role: "system", content: "You are a coding assistant." });
  assert.equal(out.messages![1].content, "Reply with exactly OK.");
});
