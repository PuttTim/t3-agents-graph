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

**Replay** (or press `R`) plays the thread back from its recorded timestamps at 2x, 5x or 10x.
Agents pop in when they started and cost grows as they run. Stretches where nothing was
running anywhere in the tree (e.g. overnight between turns) are squeezed to 2 seconds, so a
thread spanning a day replays in minutes. You can switch speed mid-replay. `?replay=10` starts
one on load, and `?at=0.5` starts it halfway.

Click a card to see its prompt, result, tools, tokens and cost. The `2 v` button folds
children. Drag to pan, ctrl/cmd + scroll or `+` / `-` / `0` to zoom.

## Where the data comes from

All reads are read-only. Nothing goes over the network.

| What | Source |
| --- | --- |
| Tree, status, timing, prompts, results | `~/.t3/userdata/statev2.sqlite`: `orchestration_v2_projection_subagents` (native Task/Agent subagents and T3 `delegate_task` children, for every provider), plus threads whose `lineage.parentThreadId` points at a parent |
| Claude cost and tools | Claude Code transcripts: `~/.claude/projects/*/<session>.jsonl` and `*/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json` for agent type) |
| Codex cost and tools | `~/.codex/sessions/**/rollout-*-<threadId>.jsonl` (`token_count` totals) |
| Prices | `~/.t3/userdata/usage-model-rates.json`, the LiteLLM table T3 already caches |

Threads an agent starts with T3's MCP tools (`t3_thread_launch`, `create_threads`,
`t3_thread_fork`) are top-level threads with no lineage, so they're linked from the tool call's
result instead.

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

Env overrides: `PORT`, `HOST`, `AGENT_GRAPH_NAME`, `AGENT_GRAPH_TOKEN`, `T3_USERDATA`, `T3_DB`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`.
