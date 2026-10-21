# WorkBuddy plugin backup

This folder is a TypeScript conversion of `packages/workbuddy` from
https://github.com/magpie-community/plugins at revision
`af360a529df5295e9c31fefe81e3158802ca0f3a` (package version `0.1.29`).

The plugin remains a Magpie/OpenCode-compatible plugin. It exports
`WorkBuddyAuthPlugin` and `WorkBuddyAIAuthPlugin` and keeps the original browser
sign-in, desktop sign-in, refresh, usage, model and request hooks. It is not a pi
extension.

The conversion adds TypeScript annotations and `types.ts`; runtime behavior is
covered by the original test suite, converted to TypeScript. `LICENSE` is copied
from the upstream repository root.

To install this plugin from a local checkout:

```sh
magpie plugin add /absolute/path/to/magpie-portkey/workbuddy
```

Installing the repository root loads the separate Portkey provider. Install this
folder to load the WorkBuddy plugin. See [README.md](README.md) for the original
plugin's features and sign-in instructions.

To check and test it from the repository root:

```sh
npm run typecheck:workbuddy
npm run test:workbuddy
```
