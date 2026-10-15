# Magpie marketplace listing

Magpie documents three ways to discover third-party providers in [Publishing and listing](https://usemagpie.ai/docs/plugins#publish). The source references below were checked against Magpie’s `main` branch.

## GitHub discovery

A public repository with the **`magpie-plugin`** topic is eligible for **Plugins → Discover → Unofficial, on GitHub**. This repository uses that topic.

Magpie requires `package.json` at the repository root and a committed, loadable entry file. This package declares `main: "./index.ts"` as well as its pi extension manifest, so discovery can verify the entry. Forks, archived repositories and magpie-community’s own repositories are excluded. Magpie refreshes its GitHub search at most every ten minutes; GitHub’s own indexing may take additional time.

No npm publication is required for this path. Until a matching npm publication exists, install with:

```sh
magpie plugin add github:TianZuo555/magpie-portkey
```

Sources: [github.go](https://github.com/yetone/magpie/blob/main/internal/plugin/github.go), especially `TaggedRepos`, `readTagged` and `pkgEntry`.

## Curated public list

The suggested list is [magpie-community/plugins/registry.json](https://github.com/magpie-community/plugins/blob/main/registry.json). To join it, publish the package to npm, then open a pull request against that repository adding an entry like:

```json
{
  "package": "magpie-portkey",
  "name": "Portkey AWS Bedrock",
  "icon": "https://raw.githubusercontent.com/TianZuo555/magpie-portkey/main/icon.svg",
  "providers": ["portkey-aws"],
  "summary": {
    "en": "AWS Bedrock through Portkey, with tools, vision, reasoning and prompt caching.",
    "zh": "通过 Portkey 使用 AWS Bedrock，支持工具调用、图像、推理和提示词缓存。"
  }
}
```

Use the npm name actually published if `magpie-portkey` is unavailable. Keep `community` unset: this is an independently maintained package. Maintainers review and merge the listing; creating a GitHub repository or adding its topic does not grant curated status.

Magpie fetches this registry at most every six hours and bundles a fallback copy. To test a candidate registry, launch Magpie with `MAGPIE_PLUGIN_MARKET` set to a URL serving the complete candidate registry JSON.

Sources: [community README → The market](https://github.com/magpie-community/plugins#the-market), [market.go](https://github.com/yetone/magpie/blob/main/internal/plugin/market.go).

## npm search

Magpie also searches npm. For a pi provider package, include `pi-package` plus `provider` or `auth` in the name or keywords. This package includes `pi-package` and `provider`, and has its GitHub `repository` metadata. After npm publication, it is eligible for that search.

Before publishing, confirm the npm package name is available, run `npm run check`, and inspect `npm pack --dry-run`. The public tarball must exclude `config.local.json` and all credentials. No npm publication or curated-list pull request is performed merely by creating the GitHub repository.
