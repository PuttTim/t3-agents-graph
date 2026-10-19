// Shows Conductor (conductor.build) history next to T3 threads, straight from its local DB.
// Conductor drives Claude Code / Codex and stores every SDK message per session, so the tree,
// timing and cost come from those messages: subagent messages carry `parent_tool_use_id`, which
// is the Agent tool call that started them. Ids are prefixed `conductor:` to keep them apart.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { claudeUsage, type Usage } from "./usage";
import { firstLine, prettyName, type AgentNode, type ThreadSummary } from "./t3";

const DB_PATH =
  process.env.CONDUCTOR_DB ?? join(homedir(), "Library", "Application Support", "com.conductor.app", "conductor.db");
const PREFIX = "conductor:";
const AGENT_TOOLS = ["Agent", "Task"];

export const isConductorId = (id: string) => id.startsWith(PREFIX);

let db: Database | null | undefined;
function conn(): Database | null {
  if (db === undefined) db = existsSync(DB_PATH) ? new Database(DB_PATH, { readonly: true }) : null;
  return db;
}

const parse = (s: string | null) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

/** Changes whenever Conductor writes a session or message, so caches stay valid while it's idle. */
function version(c: Database) {
  const r = c
    .query(`select (select max(rowid) from session_messages) as m, (select max(updated_at) from sessions) as s`)
    .get() as { m: number | null; s: string | null };
  return `${r.m}:${r.s}`;
}

const provider = (agentType: string | null) => (agentType === "codex" ? "codex" : "claudeAgent");
const running = (status: string | null) => status === "working" || status === "running";

type SessionRow = {
  id: string;
  title: string | null;
  status: string | null;
  agent_type: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  workspace: string | null;
  branch: string | null;
  repo_id: string;
  repo: string;
  root: string | null;
};

const SESSION_SQL = `
  select s.id, s.title, s.status, s.agent_type, s.model, s.created_at, s.updated_at,
         w.directory_name as workspace, w.branch, r.id as repo_id, r.name as repo, r.root_path as root
  from sessions s join workspaces w on w.id = s.workspace_id join repos r on r.id = w.repository_id`;

function sessionTitle(s: SessionRow) {
  const title = s.title && s.title !== "Untitled" ? s.title : (s.branch ?? "Untitled");
  return s.workspace ? `${title} · ${s.workspace}` : title;
}

// ---------- thread list ----------

let listCache: { key: string; value: ThreadSummary[] } | null = null;

export function listConductorThreads(): ThreadSummary[] {
  const c = conn();
  if (!c) return [];
  const key = version(c);
  if (listCache?.key === key) return listCache.value;
  const agents = new Map(
    (
      c
        .query(
          `select m.session_id as id, count(*) as n
           from session_messages m, json_each(json_extract(m.content, '$.message.content')) j
           where m.content like '%"tool_use"%' and json_valid(m.content)
             and json_extract(j.value, '$.type') = 'tool_use'
             and json_extract(j.value, '$.name') in (${AGENT_TOOLS.map(() => "?").join(",")})
           group by 1`,
        )
        .all(...AGENT_TOOLS) as { id: string; n: number }[]
    ).map((r) => [r.id, r.n]),
  );
  const rows = c.query(`${SESSION_SQL} order by s.updated_at desc`).all() as SessionRow[];
  const value = rows.map((s) => ({
    threadId: PREFIX + s.id,
    title: sessionTitle(s),
    provider: provider(s.agent_type),
    updatedAt: s.updated_at,
    agents: agents.get(s.id) ?? 0,
    running: running(s.status),
    projectId: PREFIX + s.repo_id,
    project: `${s.repo} (Conductor)`,
    workspaceRoot: s.root,
  }));
  listCache = { key, value };
  return value;
}

// ---------- tree ----------

const treeCache = new Map<string, { key: string; tree: AgentNode | null }>();

const toolResultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("\n")
      : "";

export function buildConductorTree(threadId: string): AgentNode | null {
  const c = conn();
  if (!c) return null;
  const key = version(c);
  let hit = treeCache.get(threadId);
  if (hit?.key !== key) treeCache.set(threadId, (hit = { key, tree: build(c, threadId.slice(PREFIX.length)) }));
  // Callers re-parent trees (project view), so hand out copies.
  return hit.tree && structuredClone(hit.tree);
}

function build(c: Database, sessionId: string): AgentNode | null {
  const s = c.query(`${SESSION_SQL} where s.id = ?`).get(sessionId) as SessionRow | null;
  if (!s) return null;
  const rows = c
    .query(
      `select role, content, created_at from session_messages
       where session_id = ? and cancelled_at is null order by created_at, rowid`,
    )
    .all(sessionId) as { role: string; content: string | null; created_at: string }[];

  const live = running(s.status);
  const firstPrompt = rows.find((r) => r.role === "user")?.content ?? null;
  const root: AgentNode = {
    id: `thread:${PREFIX}${sessionId}`,
    threadId: PREFIX + sessionId,
    parentId: null,
    origin: "root",
    provider: provider(s.agent_type),
    name: sessionTitle(s),
    model: null,
    task: firstLine(firstPrompt) || sessionTitle(s),
    prompt: firstPrompt,
    result: null,
    status: live ? "running" : "done",
    startedAt: rows[0]?.created_at ?? s.created_at,
    completedAt: live ? null : (rows[rows.length - 1]?.created_at ?? s.updated_at),
    activeMs: 0,
    runStartedAt: null,
    runs: [],
    costUsd: null,
    tokens: 0,
    usageSource: "none",
    tools: [],
    children: [],
  };

  // Agent tool call id -> node; messages are grouped by the agent that produced them.
  const agents = new Map<string, AgentNode>();
  const entries = new Map<string, any[]>([["root", []]]);
  const billed = new Map<string, { cost: number; tokens: number }>();
  let unsplit = 0;
  let turnStart: string | null = null;

  for (const r of rows) {
    if (r.role === "user") {
      turnStart ??= r.created_at;
      continue;
    }
    const d = parse(r.content);
    if (!d) continue;
    const owner: string = d.parent_tool_use_id ?? "root";

    if (d.type === "assistant") {
      (entries.get(owner) ?? entries.set(owner, []).get(owner)!).push(d);
      for (const b of d.message?.content ?? []) {
        if (b?.type !== "tool_use" || !AGENT_TOOLS.includes(b.name)) continue;
        const input = b.input ?? {};
        const title: string = input.description ?? "Subagent";
        const name = prettyName(input.subagent_type ?? title);
        const node: AgentNode = {
          id: `${PREFIX}${b.id}`,
          threadId: null,
          parentId: null,
          origin: "provider_native",
          provider: root.provider,
          name,
          model: input.model ?? null,
          task: name.toLowerCase() === prettyName(title).toLowerCase() ? firstLine(input.prompt) || title : title,
          prompt: input.prompt ?? null,
          result: null,
          status: live ? "running" : "stopped",
          startedAt: r.created_at,
          completedAt: null,
          costUsd: null,
          tokens: 0,
          usageSource: "none",
          tools: [],
          children: [],
        };
        const parent = owner === "root" ? root : (agents.get(owner) ?? root);
        node.parentId = parent.id;
        parent.children.push(node);
        agents.set(b.id, node);
      }
    } else if (d.type === "user") {
      for (const b of d.message?.content ?? []) {
        const node = b?.type === "tool_result" ? agents.get(b.tool_use_id) : undefined;
        if (!node) continue;
        const text = toolResultText(b.content);
        // Background agents return right away and finish later with a task_notification.
        if (/^Async agent launched/.test(text)) continue;
        node.result = text;
        node.status = b.is_error ? "failed" : "done";
        node.completedAt = r.created_at;
      }
    } else if (d.type === "system" && d.subtype === "task_notification" && d.tool_use_id) {
      const node = agents.get(d.tool_use_id);
      if (!node) continue;
      node.status = d.status === "completed" ? "done" : d.status === "failed" ? "failed" : "stopped";
      node.completedAt = r.created_at;
      node.result ??= d.summary ?? null;
    } else if (d.type === "result" && owner === "root") {
      // One per turn: duration_ms bounds when the session was actually working.
      const end = r.created_at;
      const start = d.duration_ms ? new Date(Date.parse(end) - d.duration_ms).toISOString() : (turnStart ?? end);
      root.runs!.push({ start, end });
      root.activeMs! += Math.max(0, Date.parse(end) - Date.parse(start));
      root.result = typeof d.result === "string" ? d.result : root.result;
      if (d.is_error) root.status = "failed";
      turnStart = null;
      // Older SDKs bill each model; newer ones only report the turn's total.
      const perModel = Object.entries<any>(d.modelUsage ?? {}).filter(([, m]) => m.costUSD != null);
      if (!perModel.length) unsplit += d.total_cost_usd ?? 0;
      for (const [model, m] of perModel) {
        const b = billed.get(baseModel(model)) ?? { cost: 0, tokens: 0 };
        b.cost += m.costUSD;
        b.tokens += (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
        billed.set(baseModel(model), b);
      }
    }
  }
  if (live) {
    root.runStartedAt = turnStart ?? rows[rows.length - 1]?.created_at ?? null;
    if (root.runStartedAt) root.runs!.push({ start: root.runStartedAt, end: null });
  }

  applyUsage(root, agents, entries, billed, unsplit);
  root.model ??= s.model;
  return root;
}

const baseModel = (m: string) => m.replace(/\[.*\]$/, ""); // claude-opus-4-6[1m]

// Rough relative price of each token kind (Anthropic's ratios), only used to split a bill.
const weight = (u: Usage) => u.input + 0.1 * u.cacheRead + 1.25 * u.cacheWrite5m + 2 * u.cacheWrite1h + 5 * u.output;
const tokens = (u: Usage) => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h + u.output;

/**
 * Conductor keeps streamed messages, whose usage is an early snapshot, and not every API call, so
 * summing them undercounts. Each turn's result has what the SDK billed, so split that instead:
 * per-model bills by each agent's share of that model's stored traffic, and turn totals without
 * a per-model breakdown (`unsplit`) by each agent's priced estimate. Totals then match exactly.
 */
function applyUsage(
  root: AgentNode,
  agents: Map<string, AgentNode>,
  entries: Map<string, any[]>,
  billed: Map<string, { cost: number; tokens: number }>,
  unsplit: number,
) {
  const shares: { node: AgentNode; model: string; u: Usage }[] = [];
  const modelW = new Map<string, number>();
  for (const [owner, list] of entries) {
    const node = owner === "root" ? root : agents.get(owner);
    if (!node || !list.length) continue;
    const all = claudeUsage(list);
    node.tools = all.tools;
    node.model ??= all.models[0] ?? null;
    node.usageSource = "transcript";
    for (const model of all.models) {
      const u = claudeUsage(list.filter((d) => d.message?.model === model));
      shares.push({ node, model, u });
      modelW.set(model, (modelW.get(model) ?? 0) + weight(u));
    }
  }
  const nodes = new Set([root, ...shares.map((s) => s.node)]);
  const anyBill = billed.size > 0 || unsplit > 0;
  for (const n of nodes) ((n.costUsd = anyBill ? 0 : null), (n.tokens = 0));

  const open = shares.filter((s) => !billed.has(s.model) || !modelW.get(s.model));
  const pool = open.length ? open : shares;
  const estimate = pool.reduce((sum, s) => sum + (s.u.costUsd ?? 0), 0);
  const scale = unsplit > 0 && estimate > 0 ? unsplit / estimate : 1;
  for (const s of shares) {
    const b = billed.get(s.model);
    const w = modelW.get(s.model)!;
    if (b && w > 0) {
      s.node.costUsd! += (b.cost * weight(s.u)) / w;
      s.node.tokens += Math.round((b.tokens * weight(s.u)) / w);
    }
    if (pool.includes(s) && (unsplit > 0 || !b)) {
      // No bill at all yet (first turn still running): just price the stored messages.
      if (s.u.costUsd != null) s.node.costUsd = (s.node.costUsd ?? 0) + s.u.costUsd * scale;
      s.node.tokens += Math.round(tokens(s.u) * scale);
    }
  }
  // Bills nothing stored can explain (e.g. title generation) belong to the session itself.
  for (const [model, b] of billed)
    if (!modelW.get(model)) {
      root.costUsd = (root.costUsd ?? 0) + b.cost;
      root.tokens += b.tokens;
    }
  if (unsplit > 0 && estimate === 0) root.costUsd = (root.costUsd ?? 0) + unsplit;
}

// ---------- projects ----------

/** Every session in a Conductor repo (all its workspaces) as one forest, like a T3 project. */
export function buildConductorProject(projectId: string, limit = 12): AgentNode | null {
  const c = conn();
  if (!c) return null;
  const repo = c.query(`select id, name, root_path from repos where id = ?`).get(projectId.slice(PREFIX.length)) as {
    id: string;
    name: string;
    root_path: string | null;
  } | null;
  if (!repo) return null;
  const threads = listConductorThreads()
    .filter((t) => t.projectId === projectId)
    .slice(0, limit)
    .reverse() // oldest first, left to right
    .map((t) => buildConductorTree(t.threadId))
    .filter((t): t is AgentNode => !!t);
  const project: AgentNode = {
    id: `project:${projectId}`,
    threadId: null,
    parentId: null,
    origin: "project",
    provider: "project",
    name: `${repo.name} (Conductor)`,
    model: repo.root_path?.replace(homedir(), "~") ?? null,
    task: `${threads.length} thread${threads.length === 1 ? "" : "s"}`,
    prompt: repo.root_path,
    result: null,
    status: threads.some((t) => t.status === "running") ? "running" : "done",
    startedAt: null,
    completedAt: null,
    costUsd: null,
    tokens: 0,
    usageSource: "none",
    tools: [],
    children: threads,
    links: [],
  };
  for (const t of threads) t.parentId = project.id;
  return project;
}
