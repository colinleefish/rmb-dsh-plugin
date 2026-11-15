# @colinleefish/rmb-dsh-plugin

DeepSeek Harness (DSH) Host bundle that connects a local [RMB Desktop](https://github.com/colinleefish/rmb-desktop) daemon to the harness:

- **Capture** finished turns into `rmbd` (`source=dsh`)
- **Recall** with `rmb_search` / `rmb_cat` tools + a system-prompt guide

Requires a running RMB Desktop daemon on loopback (default `http://127.0.0.1:19019`).

## Install into a DSH profile

From DeepSeek Harness (plugin manager / Host tools):

```text
install_bundle → /absolute/path/to/rmb-dsh-plugin
```

or, once published:

```bash
pnpm add @colinleefish/rmb-dsh-plugin
```

The bundle inserts Cordis row `rmb-dsh-plugin`:

```yaml
- id: rmb-dsh-plugin
  name: '@colinleefish/rmb-dsh-plugin'
  config:
    baseUrl: http://127.0.0.1:19019
    source: dsh
    capture: true
    maxPromptChars: 2000
    timeoutMs: 6000
    statePath: ~/.dsh/rmb-memory/state.json
```

## Capture semantics

- Only real dialogue: keep `user/message` when `source.kind === "user"`; skip harness injections (`runtime-context`, `skill-catalog`, `agent-instructions`, `time-context`, …). Skip empty / reasoning-only assistant steps.
- Serialized uploads + per-session `lastTurn` high-water mark (`~/.dsh/rmb-memory/state.json`) because rmbd upload is append-only.
- Truncation: 12k chars / message, 40k chars / turn.
- If rmbd is down, capture warns and drops; the chat itself is unaffected.

## Recall

- System-prompt section `memory:rmb` teaches the model to search before asking.
- Tools: `rmb_search` (hybrid) and `rmb_cat` (full text for an `rmb://` URI from search results).

## Boundaries

- Distillation is not instant (minutes). Same-session recall of a just-finished turn may miss.
- This plugin never writes the memory table directly — workers distill uploaded turns.
- Memory is global across sessions; not cwd-scoped.

## Develop

```bash
git clone https://github.com/colinleefish/rmb-dsh-plugin.git
cd rmb-dsh-plugin
node --check index.js
# then install_bundle the local path into your DSH desktop profile
```

## License

MIT
