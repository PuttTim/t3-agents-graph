// Reads per-agent token usage + tool names straight from the harness transcripts.
// Claude Code: ~/.claude/projects/*/<session>.jsonl and */<session>/subagents/agent-<id>.jsonl
// Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const CLAUDE_PROJECTS = join(process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"), "projects");
const CODEX_SESSIONS = join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "sessions");
const RATES_FILE = join(process.env.T3_USERDATA ?? join(HOME, ".t3", "userdata"), "usage-model-rates.json");

export type Usage = {
  input: number; // uncached input
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  costUsd: number | null; // null when the model has no known price
  models: string[];
  tools: string[]; // raw tool names in first-use order
};

export const emptyUsage = (): Usage => ({
  input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, costUsd: 0, models: [], tools: [],
});

export function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    output: a.output + b.output,
    costUsd: a.costUsd === null || b.costUsd === null ? (a.costUsd ?? b.costUsd) : a.costUsd + b.costUsd,
    models: [...new Set([...a.models, ...b.models])],
    tools: [...new Set([...a.tools, ...b.tools])],
  };
}

// ---------- pricing (LiteLLM table that T3 already caches) ----------

type Rate = { in: number; out: number; read: number; write: number };
let rates: Record<string, any> | null = null;
let ratesMtime = 0;
const rateCache = new Map<string, Rate | null>();

function loadRates() {
  try {
    const m = statSync(RATES_FILE).mtimeMs;
    if (rates && m === ratesMtime) return rates;
    rates = JSON.parse(readFileSync(RATES_FILE, "utf8")).document ?? {};
    ratesMtime = m;
    rateCache.clear();
  } catch {
    rates ??= {};
  }
  return rates!;
}

export function rateFor(model: string): Rate | null {
  const doc = loadRates();
  if (rateCache.has(model)) return rateCache.get(model)!;
  const m = model.replace(/\[.*\]$/, ""); // e.g. claude-opus-5-5[1m]
  const candidates = [m, `openai/${m}`, `anthropic/${m}`, `anthropic.${m}`, `gemini/${m}`];
  let hit = candidates.map((k) => doc[k]).find((v) => v?.input_cost_per_token != null);
  if (!hit) {
    const key = Object.keys(doc).find((k) => k.endsWith(`/${m}`) && doc[k]?.input_cost_per_token != null);
    hit = key ? doc[key] : undefined;
  }
  const r = hit
    ? {
        in: hit.input_cost_per_token,
        out: hit.output_cost_per_token ?? 0,
        read: hit.cache_read_input_token_cost ?? hit.input_cost_per_token,
        write: hit.cache_creation_input_token_cost ?? hit.input_cost_per_token,
      }
    : null;
  rateCache.set(model, r);
  return r;
}

// ---------- incremental file parsing (cached by mtime+size) ----------

const fileCache = new Map<string, { key: string; usage: Usage }>();

function cached(path: string, parse: (text: string) => Usage): Usage {
  let st;
  try {
    st = statSync(path);
  } catch {
    return emptyUsage();
  }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = fileCache.get(path);
  if (hit?.key === key) return hit.usage;
  const usage = parse(readFileSync(path, "utf8"));
  fileCache.set(path, { key, usage });
  return usage;
}

function parseClaude(text: string): Usage {
  const entries: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return claudeUsage(entries);
}

/** Usage from parsed Claude transcript lines (Conductor stores the same SDK messages per row). */
export function claudeUsage(entries: any[]): Usage {
  // One assistant message is split over several lines (one per content block)
  // that repeat the same usage, so dedupe on message.id.
  const byMsg = new Map<string, { model: string; u: any }>();
  const tools: string[] = [];
  for (const d of entries) {
    const msg = d?.message;
    if (d?.type !== "assistant" || !msg?.usage) continue;
    byMsg.set(msg.id ?? d.uuid, { model: msg.model, u: msg.usage });
    for (const c of msg.content ?? []) if (c?.type === "tool_use" && c.name) tools.push(c.name);
  }
  const out = emptyUsage();
  let unpriced = false;
  for (const { model, u } of byMsg.values()) {
    if (!model || model === "<synthetic>") continue;
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const w5m = (u.cache_creation_input_tokens ?? 0) - w1h;
    const row = { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, w5m, w1h, output: u.output_tokens ?? 0 };
    out.input += row.input;
    out.cacheRead += row.cacheRead;
    out.cacheWrite5m += row.w5m;
    out.cacheWrite1h += row.w1h;
    out.output += row.output;
    if (!out.models.includes(model)) out.models.push(model);
    const r = rateFor(model);
    if (!r) {
      unpriced = true;
      continue;
    }
    // 1h cache writes bill at 2x base input; 5m writes at the table's write rate.
    out.costUsd! += row.input * r.in + row.cacheRead * r.read + row.w5m * r.write + row.w1h * r.in * 2 + row.output * r.out;
  }
  if (unpriced && out.costUsd === 0) out.costUsd = null;
  out.tools = [...new Set(tools)];
  return out;
}

function parseCodex(text: string): Usage {
  let total: any = null;
  let model = "";
  const tools: string[] = [];
  for (const line of text.split("\n")) {
    if (line.includes('"token_count"')) {
      try {
        total = JSON.parse(line).payload?.info?.total_token_usage ?? total;
      } catch {}
    } else if (line.includes('"function_call"') || line.includes('"custom_tool_call"')) {
      try {
        const p = JSON.parse(line).payload;
        if (p?.name) tools.push(p.name);
      } catch {}
    } else if (!model && line.includes('"model"')) {
      const m = line.match(/"model":"([^"]+)"/);
      if (m) model = m[1];
    }
  }
  const out = emptyUsage();
  out.tools = [...new Set(tools)];
  if (!total) return out;
  const cached = total.cached_input_tokens ?? 0;
  out.input = (total.input_tokens ?? 0) - cached;
  out.cacheRead = cached;
  out.cacheWrite5m = total.cache_write_input_tokens ?? 0;
  out.output = total.output_tokens ?? 0;
  if (model) out.models = [model];
  const r = model ? rateFor(model) : null;
  out.costUsd = r ? out.input * r.in + out.cacheRead * r.read + out.cacheWrite5m * r.write + out.output * r.out : null;
  return out;
}

// ---------- locating transcripts ----------

let claudeIndex: { at: number; sessions: Map<string, string>; agents: Map<string, string> } | null = null;

function indexClaude(force = false) {
  if (claudeIndex && Date.now() - claudeIndex.at < (force ? 2_000 : 10_000)) return claudeIndex;
  const sessions = new Map<string, string>();
  const agents = new Map<string, string>();
  if (existsSync(CLAUDE_PROJECTS)) {
    for (const proj of readdirSync(CLAUDE_PROJECTS)) {
      const pdir = join(CLAUDE_PROJECTS, proj);
      let entries: string[];
      try {
        entries = readdirSync(pdir);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.endsWith(".jsonl")) sessions.set(e.slice(0, -6), join(pdir, e));
        else if (!e.includes(".")) {
          const sdir = join(pdir, e, "subagents");
          if (!existsSync(sdir)) continue;
          for (const a of readdirSync(sdir)) {
            const m = a.match(/^agent-(.+)\.jsonl$/);
            if (m) agents.set(m[1], join(sdir, a));
          }
        }
      }
    }
  }
  claudeIndex = { at: Date.now(), sessions, agents };
  return claudeIndex;
}

let codexIndex: { at: number; files: Map<string, string> } | null = null;

function indexCodex(force = false) {
  if (codexIndex && Date.now() - codexIndex.at < (force ? 2_000 : 10_000)) return codexIndex;
  const files = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && depth < 3) walk(join(dir, e.name), depth + 1);
      else if (e.name.endsWith(".jsonl")) {
        const m = basename(e.name, ".jsonl").match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
        if (m) files.set(m[1], join(dir, e.name));
      }
    }
  };
  walk(CODEX_SESSIONS, 0);
  codexIndex = { at: Date.now(), files };
  return codexIndex;
}

/** Claude Code writes agent-<id>.meta.json next to each subagent transcript (agentType, description...). */
export function claudeAgentMeta(agentId: string): { agentType?: string; description?: string } | null {
  const path = indexClaude().agents.get(agentId) ?? indexClaude(true).agents.get(agentId);
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    return null;
  }
}

export type NativeRef ={ driver: string; kind: "thread" | "task"; id: string };

/** Usage for one native harness reference, or null if we can't find its transcript. */
export function usageFor(ref: NativeRef): Usage | null {
  if (ref.driver === "claudeAgent") {
    const find = (force: boolean) => {
      const idx = indexClaude(force);
      return ref.kind === "task" ? idx.agents.get(ref.id) : idx.sessions.get(ref.id);
    };
    const path = find(false) ?? find(true);
    return path ? cached(path, parseClaude) : null;
  }
  if (ref.driver === "codex") {
    // Native codex subagent task ids look like "call_xxx:<threadUuid>".
    const id = ref.id.split(":").pop()!;
    const path = indexCodex().files.get(id) ?? indexCodex(true).files.get(id);
    return path ? cached(path, parseCodex) : null;
  }
  return null;
}
