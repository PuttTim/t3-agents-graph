<img src="assets/icon.svg" width="64" height="64" alt="">

# t3-agents-graph

A live "who started whom" agent tree for [T3 Code](https://t3.codes) threads, recreating
[this demo](https://x.com/flohoeller/status/2112150373565612534) on real subagent data.

```sh
bun start            # -> http://localhost:4317
```

- `http://localhost:4317/` follows the latest active thread that has subagents
- `?thread=<threadId>` pins one thread (or use the picker in the header)
- `?demo` replays the scenario from the original clip with fake data

The **Project / Machine** toggle sets how the picker groups threads. In Project mode each T3
project (a directory, worktrees included) is a group, and its first entry, **All threads in
<project>**, opens the project view (`?project=<projectId>`). That view puts a project card on
top with every top-level thread under it (12 most recent) and their agents below. Dashed arcs
show threads talking to each other: orange when one messaged another (`t3_thread_send`), purple
when it read or waited on it (`t3_thread_read` / `t3_thread_wait`). Click a thread card, then
**Open thread view** to zoom into it. Replay works here too, and arcs appear when the first call
happened.

**Replay** (or press `R`) plays the thread back from its recorded timestamps. Choose a 2x, 10x,
or 50x preset, or enter a custom speed from 0.1x to 1000x (10x by default; your choice is saved).
Agents pop in when they started and cost grows as they run. Stretches where nothing was
running anywhere in the tree (e.g. overnight between turns) are squeezed to 2 seconds, so a
thread spanning a day replays in minutes. You can switch speed mid-replay. `?replay=10` starts
one on load, and `?at=0.5` starts it halfway.

Click a card to see its prompt, result, tools, tokens and cost. **Open in T3** there opens that
conversation in the T3 Code desktop app through `t3code://threads/<environmentId>/<threadId>`.
Notes:

- **Which cards get it.** Threads, launched threads and `delegate_task` children open their own
  T3 thread. Native subagents (Task/Agent) have no T3 thread of their own, so theirs reads
  **Open parent thread in T3** and opens the closest parent thread. Project cards and Conductor
  history have no link.
- **Environment ID.** The environment ID is T3's UUID from `<T3_USERDATA or ~/.t3/userdata>/environment-id`.
  It is not the graph's `local` or remote machine name. Remote machines report theirs at
  `/api/local/info`. Older remote servers lack that endpoint, so their cards show no link.
- **What T3 needs.** You need a T3 build that handles these links (recent Nightly does; Alpha
  0.0.40 registers the scheme but ignores the path). If several T3 apps are installed, they all
  claim `t3code://`, and the OS picks which one opens. A remote machine's thread only opens if
  your T3 app already knows that environment, e.g. through T3 Connect.

The `2 v` button folds
children. Drag to pan, use the bottom-right zoom controls, or ctrl/cmd + scroll (trackpad pinch)
to zoom toward the pointer. `+` / `-` zoom, `0` resets to 100%, and `F` fits the tree to the
screen. Zoom ranges from 20% to 200%.

**Export** downloads the whole displayed tree as PNG (up to 2x resolution, capped for very
large trees), SVG, or JSON with tree data and costs. **Copy image** puts the PNG on the
clipboard in supported browsers. Images use the current theme, layout, collapsed branches,
and replay frame, with a title and timestamp; panning and zoom do not crop the export.
SVG uses embedded HTML (`foreignObject`), so view it in a browser; PNG export requires a
browser that supports rasterising it, such as Chromium.

## Where the data comes from

All reads are read-only. Nothing goes over the network.

| What | Source |
| --- | --- |
| Tree, status, timing, prompts, results | `~/.t3/userdata/statev2.sqlite`: `orchestration_v2_projection_subagents` (native Task/Agent subagents and T3 `delegate_task` children, for every provider), plus threads whose `lineage.parentThreadId` points at a parent |
| Claude cost and tools | Claude Code transcripts: `~/.claude/projects/*/<session>.jsonl` and `*/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json` for agent type) |
| Codex cost and tools | `~/.codex/sessions/**/rollout-*-<threadId>.jsonl` (`token_count` totals) |
| Prices | `~/.t3/userdata/usage-model-rates.json`, the LiteLLM table T3 already caches |
| Conductor history | `~/Library/Application Support/com.conductor.app/conductor.db` (if present) |

Threads an agent starts with T3's MCP tools (`t3_thread_launch`, `create_threads`,
`t3_thread_fork`) are top-level threads with no lineage, so they're linked from the tool call's
result instead.

**Conductor.** If you used [Conductor](https://conductor.build) before T3, its sessions show up
too, each repo as a "<repo> (Conductor)" project, with titles suffixed by the workspace name.
Conductor stores every SDK message, so subagents come from `parent_tool_use_id` (nesting and
background agents included) and replay uses each turn's recorded duration. Its stored messages
undercount tokens, so cost comes from what the SDK billed per turn, split across agents by their
share of the traffic; per-agent figures are close, session totals are exact.

Other harnesses (OpenCode, Cursor, ...) still show up in the tree because T3 projects their
subagents into the same table. For cost they fall back to T3's context-token snapshot.

A card's cost includes everything it started, the same way the original rolls costs up.
Thread durations count active run time only, not idle time between turns.

## Other machines (T3 Connect)

T3 Connect goes through T3's encrypted, signed cloud relay, which has no public API. So instead,
run this server on each machine and let the one you open read from the others:

```sh
# on the other machine: listen on the network, require a token
HOST=0.0.0.0 AGENT_GRAPH_TOKEN=pick-a-secret bun start

# on this machine: list it in remotes.json (see remotes.example.json), then
AGENT_GRAPH_TOKEN=pick-a-secret bun start
```

The picker then groups threads by machine. Offline machines are labelled, not fatal. The
machines need to reach each other on port 4317, e.g. over Tailscale or the LAN. If you set a
token, open the page as `http://localhost:4317/?token=...`. You can also set remotes inline:
`AGENT_GRAPH_REMOTES="Studio=http://studio:4317,PC=http://pc:4317"`.

The server listens on 127.0.0.1 unless you set `HOST`.

Env overrides: `PORT`, `HOST`, `AGENT_GRAPH_NAME`, `AGENT_GRAPH_TOKEN`, `T3_USERDATA`, `T3_DB`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CONDUCTOR_DB`.
