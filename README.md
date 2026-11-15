# @colinleefish/rmb-dsh-plugin

Give [DeepSeek Harness](https://github.com/deepseek-ai) a lasting memory through [RMB Desktop](https://github.com/colinleefish/rmb-desktop).

While you chat, finished turns are saved into the local RMB daemon. The model can search that memory later with `rmb_search` and `rmb_cat`, so it stops asking the same questions every session.

## Requirements

- [RMB Desktop](https://github.com/colinleefish/rmb-desktop) installed and running (default API: `http://127.0.0.1:19019`)
- DeepSeek Harness with permission to install Host bundles

## Install

In DeepSeek Harness, install the npm package as a Host bundle:

```text
@colinleefish/rmb-dsh-plugin
```

Or from a terminal into your DSH profile:

```bash
pnpm add @colinleefish/rmb-dsh-plugin
```

After install you should see the plugin row **RMB memory** / **RMB 记忆**. Keep RMB Desktop running while you work.

## What you get

- **Capture** — each finished turn is uploaded to RMB (`source=dsh`). Background workers turn chats into searchable memories.
- **Recall** — the model gets a short guide plus two tools:
  - `rmb_search` — hybrid search over memories (and skills)
  - `rmb_cat` — read the full text of an `rmb://…` result

Only real user and assistant text is stored. Harness injections (runtime context, skill catalogs, and similar) are skipped.

## Optional config

Defaults work for a normal local RMB install. Override the Cordis row `rmb-dsh-plugin` only if you need to:

```yaml
- id: rmb-dsh-plugin
  name: '@colinleefish/rmb-dsh-plugin'
  config:
    baseUrl: http://127.0.0.1:19019
    source: dsh
    capture: true
    maxPromptChars: 2000
    timeoutMs: 6000
```

| Field | Meaning |
|---|---|
| `baseUrl` | RMB daemon URL |
| `capture` | `false` = recall only, no uploads |
| `maxPromptChars` | Budget for the memory blurb in the system prompt (`0` = guide only) |

## Good to know

- New memories take a few minutes to distill. A turn you just finished may not show up in search yet.
- Memory is shared across sessions on this machine, not scoped to one project folder.
- If RMB is stopped, chat still works; capture is skipped until the daemon is back.

## Links

- npm: https://www.npmjs.com/package/@colinleefish/rmb-dsh-plugin
- Source: https://github.com/colinleefish/rmb-dsh-plugin
- RMB Desktop: https://github.com/colinleefish/rmb-desktop

## License

MIT
