# WorkBuddy plugin backup

This folder is a direct backup of `packages/workbuddy` from
https://github.com/magpie-community/plugins at revision
`af360a529df5295e9c31fefe81e3158802ca0f3a` (package version `0.1.29`).

The source, package manifest, tests, fixtures and README are unchanged. `LICENSE`
is copied from the upstream repository root. This file records the backup's
provenance and is the only additional file.

The package exports `WorkBuddyAuthPlugin` and `WorkBuddyAIAuthPlugin` for Magpie's
OpenCode-compatible plugin host. It includes browser sign-in and reading the
WorkBuddy desktop app's existing sign-in, as well as Magpie's refresh and usage
hooks. It is not a pi extension.

To install this backup from a local checkout:

```sh
magpie plugin add /absolute/path/to/magpie-portkey/workbuddy
```

Installing the repository root loads the separate Portkey provider. Install this
folder to load the backed-up WorkBuddy plugin. See [README.md](README.md) for the
original plugin's features and sign-in instructions.

To run its original tests from the repository root:

```sh
npm run test:workbuddy
```
