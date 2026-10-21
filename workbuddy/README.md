# magpie-workbuddy

WorkBuddy for [Magpie](https://usemagpie.ai) and [pi](https://pi.dev), as a pi
provider package. It signs in to the plans of WorkBuddy, Tencent's desktop agent
from CodeBuddy, and makes its chats.

| Provider id    | Build                                 | API                           |
| -------------- | ------------------------------------- | ----------------------------- |
| `workbuddy`    | WorkBuddy, the China build (CodeBuddy plan) | `https://copilot.tencent.com/v2` |
| `workbuddy-ai` | WorkBuddy AI, the international build  | `https://www.workbuddy.ai/v2`  |

The package exports one pi extension, which registers both providers. It is a
port of [@magpie-community/opencode-workbuddy-auth](https://github.com/magpie-community/plugins/tree/main/packages/workbuddy)
for OpenCode, and of Magpie's own built-in WorkBuddy for the desktop sign-in.

## Signing in

`/login workbuddy` (or `workbuddy-ai`) takes the account **WorkBuddy desktop is
already signed in to**, with nothing pasted or copied:

- macOS: `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop[-ai].info`
- Windows: `~/AppData/Local/CodeBuddyExtension/…`
- Linux: `~/.local/share/CodeBuddyExtension/…`

The app's file is read on each request and **never changed**: no refresh token
is held by both the app and this package. WorkBuddy 5.6 and later keep the
sign-in encrypted, which only the app opens, so the login then opens Tencent's
sign-in page instead — the one WorkBuddy's desktop app opens — and polls it
until you're signed in, for five minutes at most.

The sign-in is kept as pi's OAuth credential in `~/.pi/agent/auth.json`. A
browser sign-in keeps the access and refresh tokens, their ends, the user id and
the domain; desktop's is a marker (`{"type":"oauth","source":"desktop","uid"}`).
A browser sign-in's access token is renewed a minute before it ends, once for
the account at a time. Desktop's is renewed here only when the app hasn't
renewed it itself, and the new token is kept in memory, never written back.

An enterprise (team) account is asked for as the enterprise: every request then
carries `X-Enterprise-Id` and `X-Tenant-Id`, as WorkBuddy's own client sends
them. Without them WorkBuddy answers as the personal account, with the personal
plan's models.

## Requests

Chats are chat completions at `<API>/chat/completions`, through pi's own
openai-completions implementation. They are streamed only; WorkBuddy refuses a
chat that isn't.

Each chat carries WorkBuddy's headers: `Authorization`, `X-User-Id`, `X-Domain`,
`X-Product: SaaS`, `X-IDE-Type: WorkBuddy`, and `User-Agent: WorkBuddy/5.5.6`
(without it WorkBuddy answers error 10085). It also carries the client's, which
WorkBuddy's usage list shows as the client that asked (使用端):
`X-Agent-Purpose: conversation`, `X-IDE-Name: WorkBuddy`, `X-IDE-Version`,
`X-Agent-Intent: craft`, `X-Requested-With`. WorkBuddy AI also takes
`X-Agent-Type: main`.

The conversation's ids go with them: `X-Conversation-ID`,
`X-Conversation-Request-ID`, `X-Conversation-Message-ID` and `X-Request-ID`.
WorkBuddy's backend counts a user send as one request by
`X-Conversation-Request-ID`, so every step of one send — a tool result sent
back, a retry — carries the same one, and the user's next message carries
another. The conversation is pi's session id, else the chat's first user
message.

A chat that doesn't open with a system message is given WorkBuddy's default
one. `max_completion_tokens` is sent as `max_tokens`, `developer` messages as
`system`, and an object `tool_choice` as WorkBuddy's string form.

WorkBuddy refuses some agents' identity lines as an "unapproved channel"
(11128), so those lines are reworded before a chat goes out: Claude Code's,
Codex's, and DeepSeek Harness's. A refusal of words not reworded yet is sent
once more, with the system prompt moved into the first user message (inside
`<instructions>` tags) and WorkBuddy's default system prompt in its place:
WorkBuddy checks only the system and assistant messages, and the line it
matched is then in neither. A system message later in the chat becomes a user
message where it stands. The package remembers each refused system prompt while
it is loaded, so that agent's next chats go moved at once. A refusal that
stands after the move (words in an assistant message) ends in a hint that names
no client.

A chat's tools are given shapes WorkBuddy's models take. Without them WorkBuddy
AI answers 400 "Invalid request parameters" (11133) — DeepSeek's models to each
shape below and Kimi's, GPT's, Gemini's and GLM's to some:

- a tool's parameters with no `type`, empty, or a union (`anyOf`, `oneOf`,
  `allOf`) at the root are an object, the union's fields merged;
- a `pattern`'s `\0` is `\u0000`, which matches the same;
- a tuple's `items` (a list) is one schema any of them fits;
- an `enum` with no `type` takes its values' type (or that and `"null"`), and
  an `enum` of several types is an `anyOf` of one typed `enum` for each, at any
  depth; an empty `enum` is left out;
- `true` and `false` where a schema goes are `{}` and `{"not": {}}`; a
  `required` that isn't a list, and a `type` JSON Schema doesn't name, are left
  out, and `"String"` is `"string"`;
- a tool's name with a character other than letters, digits, `_` and `-` is
  sent with `_` there, and the model's calls come back under the tool's own
  name.

WorkBuddy AI's `gemini-3.8-flash` answers 400 "the conversation must end with a
user message" (11153) to a chat whose tool results are followed by the user's
message. Such a chat goes again with an empty assistant message between them; a
model that refused it once gets it that way from then on, until the package
reloads.

## Models

When you are signed in, the models are the ones WorkBuddy's product config
gives its CLI agent (`GET /v3/config`), with their context, image input and
reasoning levels. Until then, or if WorkBuddy doesn't answer, the list the
package ships is used.

`workbuddy`: Auto, Hy4 preview, Hy3, Hy3-X, Deepseek-V4.1-Flash,
Deepseek-V4-Pro, GLM-5.3, GLM-5.3-Flash, GLM-5.2, GLM-5.1, GLM-5v-Turbo,
MiniMax-M3, Kimi-K3, Kimi-K2.7-Code, Kimi-K2.6.

`workbuddy-ai`: Default, Fast, Balanced, Primary, Deep, GPT-5.5, GPT-5.4,
GPT-5.3-Codex, Gemini-3.1-Pro, Gemini-3.5-Flash, GLM-5.3, GLM-5.2, Hy3, Kimi-K3,
Kimi-K2.6, MiniMax-M3.

A model's reasoning levels are its `reasoningEffort` variants. WorkBuddy AI's
GLM models drop images server-side whatever its config says, so pi lists them as
text-only.

## When free models work but a credit model does not

Check the failing account and model separately before concluding that the wallet
is empty:

- Use the exact API id from the account's model list. `glm-5.3-flash` is the
  id; `GLM-5.3-Flash` is its display name.
- The WorkBuddy 5.6+ encrypted-desktop message means this sign-in cannot be
  read, not that the account has zero credits. Sign in again in the browser,
  for the same build.
- An account restricted by WorkBuddy is a different failure. Code 11140 with its
  unusual-activity message calls for **Submit feedback** in WorkBuddy; signing
  in repeatedly or changing the model does not lift it.

## Not here

Magpie's built-in WorkBuddy does more than this package:

- the daily check-in;
- the credits meter (`/billing/meter/get-user-resource-summary`) and the usage
  card;
- several accounts under one provider.

pi's provider API has no place for these. A chat's `free` and `rate` — a model
served at no cost to the plan's credits, and the credits a request costs — are
read from WorkBuddy's config but pi has no model field for them.

## Development

```sh
npm install --ignore-scripts
npm test          # bun test
npm run typecheck
```

To try it in pi, point pi at this folder:

```sh
pi -e ./workbuddy
```
