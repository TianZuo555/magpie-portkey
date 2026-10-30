# magpie-portkey

Providers for [Magpie](https://github.com/yetone/magpie) and [pi](https://pi.dev).

| Folder | Provider ids | What it is |
|---|---|---|
| this folder | `portkey-aws` | AWS Bedrock through [Portkey](https://portkey.ai) |
| [`workbuddy/`](workbuddy/) | `workbuddy`, `workbuddy-ai` | TypeScript backup of the original Magpie/OpenCode plugin, including desktop sign-in |

The `workbuddy/` folder is a TypeScript conversion of the original plugin from
[`magpie-community/plugins`](https://github.com/magpie-community/plugins/tree/af360a529df5295e9c31fefe81e3158802ca0f3a/packages/workbuddy),
version `0.1.29`. It uses Magpie's native plugin hooks and has no pi extension
manifest. See [conversion provenance and local installation](workbuddy/BACKUP.md).

## Portkey AWS Bedrock

A provider for AWS Bedrock models through Portkey. It uses Magpie’s official pi package bridge and the Bedrock AI SDK transport. The same package also works in pi.

The provider id is **`portkey-aws`**. Its models are available to every agent connected to Magpie.

## Install in Magpie

```sh
magpie plugin add github:TianZuo555/magpie-portkey
magpie plugin login portkey-aws
```

Enter your **Portkey gateway API key** in Magpie’s API-key sign-in. Magpie stores it in `plugin-auth.json` under its configuration directory and supplies the account’s key for each request. Multiple accounts are supported.

Configure your gateway URL and AWS route before making requests, as described below. In Magpie, select **Providers → Portkey Bedrock (Vercel AI SDK)**, then choose a `portkey-aws/…` model for your agent. For example:

```sh
magpie claude portkey-aws/us.anthropic.claude-opus-4-8
```

This requires a Magpie version with pi package support. Magpie installs Bun, the plugin’s runtime dependencies and its pi runtime when needed. For local development:

```sh
git clone https://github.com/TianZuo555/magpie-portkey.git
cd magpie-portkey
npm install --ignore-scripts
magpie plugin add "$PWD"
```

To reload edits in the app, turn this plugin off and on in Plugins.

## Configure your gateway

The package ships this public default in `config.json`:

```json
{
  "baseUrl": "https://api.portkey.ai/v1",
  "apiKeyEnv": "PORTKEY_API_KEY",
  "provider": "aws-bedrock",
  "headers": {}
}
```

Create `config.local.json` beside `index.ts` to override it. That file is ignored by git and excluded from the npm package. You can also set `PORTKEY_CONFIG_PATH` to an absolute configuration file path in Magpie’s launch environment. Loading order is `PORTKEY_CONFIG_PATH`, then `config.local.json`, then `config.json`; each selects a complete configuration file.

- `baseUrl`: your Portkey gateway’s Bedrock-compatible base URL. Requests go to `/model/{encoded model id}/converse-stream`.
- `apiKeyEnv`: environment fallback when pi has no saved key. In Magpie, use API-key sign-in so the menu bar app does not need your shell environment.
- `provider`: optional `x-portkey-provider` route. Set this to your configured Portkey AWS provider slug, such as `@your-aws-provider`, when using a provider integration.
- `configId`: optional `x-portkey-config` configuration id. Use a route or configuration with AWS credentials already configured in Portkey.
- `headers`: additional non-secret gateway headers.

Credentials belong in Magpie’s sign-in or the environment. The reader rejects API keys and secret headers embedded in JSON. Requests send the selected account’s key as both `Authorization: Bearer …` and `x-portkey-api-key`. Restart the plugin after configuration changes.

## Models

`models.json` is an editable catalog. Set `PORTKEY_MODELS_PATH` to an absolute file path to keep it outside the package. Entries may be model ID strings or objects with `id`, `name`, `reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, `maxTokens` and `cost`. Prices are USD per million tokens, with separate `input`, `output`, `cacheRead` and `cacheWrite` values.

The included catalog comes from the original pi integration. Availability, limits and prices depend on your AWS account and Portkey route; update the catalog to match them.

| Model id | Context | Max output |
| --- | ---: | ---: |
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | 200,000 | 64,000 |
| `us.anthropic.claude-opus-4-8` | 1,000,000 | 64,000 |
| `us.anthropic.claude-opus-5` | 1,000,000 | 64,000 |
| `us.anthropic.claude-opus-5-5` | 1,000,000 | 128,000 |
| `us.anthropic.claude-sonnet-5` | 1,000,000 | 64,000 |
| `us.anthropic.claude-sonnet-5-5` | 1,000,000 | 128,000 |

## Features

- Native Bedrock Converse streaming through `@ai-sdk/amazon-bedrock`.
- Text, vision, streamed tool arguments and tool results, including image results and failed tools.
- Reasoning levels, including `xhigh` and `max` where declared; signed and redacted reasoning survives replay. Thinking streams with `display: summarized`, so the first token arrives while the model reasons instead of after the whole reasoning pass.
- Two explicit prompt-cache checkpoints: the system prompt and the final conversation message. Bedrock determines cache eligibility and retention.
- Input, output, cache-read and cache-write token accounting with the catalog’s prices.
- Cancellation, request timeouts, payload inspection and response hooks.
- HTTP status and retry headers forwarded to Magpie for its routing and failover logic. The SDK does not retry independently.

Unsigned thinking from another provider is replayed as text. Incomplete streams and invalid tool JSON become errors. The provider reads system prompts and tools from pi’s current transcript API.

Requests are sent uncompressed. Portkey’s deployed gateway reads the body as plain JSON and does not decompress: a gzip or deflate body answers `400` with `Value null at 'messages'` even at 95 bytes, on both `/model/{id}/converse-stream` and `/v1/messages`. Compressing the request needs the gateway to enable request decompression first. Responses are also sent uncompressed, and `Accept-Encoding: gzip, br` changes nothing.

## Use in pi

From a local checkout:

```sh
pi -e ./index.ts
```

Use `/login` for `portkey-aws`, or export the variable named by `apiKeyEnv`. Enable only one copy of this provider per session.

## Development and verification

Tested with pi 1.2.0 and Magpie’s Bun plugin host.

```sh
npm install --ignore-scripts
npm run check
```

Type checking uses [`tsrs`](https://www.npmjs.com/package/tsrs), the Rust port of the TypeScript 7 compiler, instead of `tsc`.

Tests use real AWS event-stream frames against the Bedrock SDK to verify authentication, conversion, tools, images, reasoning, cache markers, usage, Unicode chunk boundaries, aborts and failures. No live credentials are used.

For integration coverage:

```sh
git clone --depth 1 https://github.com/yetone/magpie.git /tmp/magpie
MAGPIE_SOURCE_DIR=/tmp/magpie npm run check
```

This starts Magpie’s actual `internal/plugin/host.js` under Bun in a temporary configuration directory. It loads the package through Magpie’s pi bridge, signs in test accounts, and sends Anthropic requests through a local Bedrock fixture server. Without `MAGPIE_SOURCE_DIR`, that integration test is skipped. Live Portkey access is not part of the automated tests.

`npm pack` creates an installable archive containing the provider, public defaults, catalog and documentation. Dependencies, tests and local overrides are excluded.

## Marketplace

The repository is tagged `magpie-plugin` for automatic discovery under **Plugins → Discover → Unofficial, on GitHub**. See [marketplace listing instructions](docs/marketplace.md) for the curated registry and npm search requirements.
