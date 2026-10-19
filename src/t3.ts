// Builds "who started whom" agent trees from T3 Code's local orchestration DB.
// Works for every harness T3 drives: subagents are projected provider-agnostically
// into orchestration_v2_projection_subagents (native Task/Agent tools and T3 delegate_task alike).
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildConductorProject, buildConductorTree, isConductorId, listConductorThreads } from "./conductor";
import { claudeAgentMeta, emptyUsage, mergeUsage, usageFor, type NativeRef, type Usage } from "./usage";

const USERDATA = process.env.T3_USERDATA ?? join(homedir(), ".t3", "userdata");
const DB_PATH = process.env.T3_DB ?? join(USERDATA, "statev2.sqlite");

/** T3's own UUID for this install, which its `t3code://threads/<env>/<thread>` links need. */
let environmentId: string | null = null;
export function t3EnvironmentId(): string | null {
  if (environmentId) return environmentId;
  try {
    environmentId = readFileSync(join(USERDATA, "environment-id"), "utf8").trim() || null;
  } catch {}
  return environmentId;
}

let db: Database | null = null;
function conn() {
  db ??= new Database(DB_PATH, { readonly: true });
  return db;
}

export type Status = "running" | "done" | "stopped" | "failed" | "waiting";

export type AgentNode = {
  id: string;
  threadId: string | null;
  parentId: string | null;
  origin: "root" | "provider_native" | "app_owned" | "thread" | "project";
  provider: string; // claudeAgent | codex | opencode | cursor | ...
  name: string;
  model: string | null;
  task: string;
  prompt: string | null;
  result: string | null;
  status: Status;
  startedAt: string | null;
  completedAt: string | null;
  /** Threads only: time spent in finished runs, plus when the current run started (threads idle between turns). */
  activeMs?: number;
  runStartedAt?: string | null;
  /** Threads only: each run's interval, used by the replay to know when the thread was working. */
  runs?: { start: string; end: string | null }[];
  costUsd: number | null;
  tokens: number;
  usageSource: "transcript" | "context" | "none";
  tools: string[];
  children: AgentNode[];
  /** Project view only: thread-to-thread calls (t3_thread_send / read / wait) between cards. */
  links?: ThreadLink[];
};

export type ThreadLink = {
  from: string; // node id of the caller
  to: string; // node id of the thread it talked to
  kind: "message" | "read";
  count: number;
  at: string; // first call, so a replay can draw the link when it happened
};

export type ThreadSummary = {
  threadId: string;
  title: string;
  provider: string;
  updatedAt: string;
  agents: number;
  running: boolean;
  projectId: string;
  project: string;
  workspaceRoot: string | null;
};

const parse = (s: string | null) => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

function mapStatus(s: string | null | undefined): Status {
  switch (s) {
    case "running":
    case "pending":
    case "starting":
    case "in_progress":
      return "running";
    case "waiting":
    case "waiting_for_input":
    case "awaiting_approval":
      return "waiting";
    case "completed":
    case "succeeded":
      return "done";
    case "failed":
    case "errored":
    case "error":
      return "failed";
    default:
      return s ? "stopped" : "running";
  }
}

export const firstLine = (s: string | null | undefined, max = 160) => {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

export const prettyName = (s: string) =>
  s
    .replace(/^\/?root\//, "")
    .replace(/[-_]+/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());

// ---------- queries ----------

type ThreadRow = { thread_id: string; title: string; default_provider: string; updated_at: string; payload_json: string };

function threadRow(id: string): ThreadRow | null {
  return conn()
    .query(
      `select thread_id, title, default_provider, updated_at, payload_json
       from orchestration_v2_projection_threads where thread_id = ? and deleted_at is null`,
    )
    .get(id) as ThreadRow | null;
}

function threadRunState(id: string) {
  const rows = conn()
    .query(
      `select status, requested_at, completed_at from orchestration_v2_projection_runs
       where thread_id = ? order by ordinal`,
    )
    .all(id) as { status: string; requested_at: string; completed_at: string | null }[];
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const running = rows.some((r) => mapStatus(r.status) === "running");
  let activeMs = 0;
  let runStartedAt: string | null = null;
  for (const r of rows) {
    if (mapStatus(r.status) === "running") runStartedAt = r.requested_at;
    else if (r.completed_at) activeMs += Math.max(0, Date.parse(r.completed_at) - Date.parse(r.requested_at));
  }
  return {
    status: running ? ("running" as Status) : mapStatus(last.status),
    startedAt: rows[0].requested_at,
    completedAt: running ? null : last.completed_at,
    activeMs,
    runStartedAt,
    runs: rows.map((r) => ({ start: r.requested_at, end: mapStatus(r.status) === "running" ? null : r.completed_at })),
  };
}

function legacyRun(id: string) {
  const span = legacySpan(id);
  if (!span) return null;
  return { status: "done" as Status, ...span, runStartedAt: null, runs: [{ start: span.startedAt, end: span.completedAt }] };
}

function firstUserMessage(id: string): string | null {
  const row = conn()
    .query(
      `select json_extract(payload_json, '$.text') as text from orchestration_v2_projection_turn_items
       where thread_id = ? and type = 'user_message' order by ordinal limit 1`,
    )
    .get(id) as { text: string } | null;
  if (row?.text) return row.text;
  const legacy = conn()
    .query(`select text from projection_thread_messages where thread_id = ? and role = 'user' order by created_at limit 1`)
    .get(id) as { text: string } | null;
  return legacy?.text ?? null;
}

function nativeThreadRefs(threadId: string): NativeRef[] {
  const rows = conn()
    .query(
      `select json_extract(payload_json, '$.nativeThreadRef.driver') as driver,
              json_extract(payload_json, '$.nativeThreadRef.nativeId') as id
       from orchestration_v2_projection_provider_threads where thread_id = ?`,
    )
    .all(threadId) as { driver: string; id: string }[];
  const refs: NativeRef[] = rows
    .filter((r) => r.driver && r.id && !r.id.startsWith("pending"))
    .map((r) => ({ driver: r.driver, kind: "thread", id: r.id }));
  return refs.length ? refs : legacyThreadRefs(threadId);
}

/** Threads imported from T3's v1 store only keep their native id in the session's resume cursor. */
function legacyThreadRefs(threadId: string): NativeRef[] {
  const row = conn()
    .query(`select provider_name, resume_cursor_json from provider_session_runtime where thread_id = ?`)
    .get(threadId) as { provider_name: string; resume_cursor_json: string | null } | null;
  if (!row?.resume_cursor_json) return [];
  const cursor = parse(row.resume_cursor_json);
  const driver = /claude/i.test(row.provider_name) ? "claudeAgent" : row.provider_name;
  const id = cursor.threadId ?? cursor.sessionId ?? cursor.resume ?? cursor.session_id;
  return typeof id === "string" ? [{ driver, kind: "thread", id }] : [];
}

/** v1 threads have no runs; their first and last message bound how long they ran. */
function legacySpan(threadId: string) {
  const row = conn()
    .query(`select min(created_at) as a, max(updated_at) as b from projection_thread_messages where thread_id = ?`)
    .get(threadId) as { a: string | null; b: string | null } | null;
  return row?.a ? { startedAt: row.a, completedAt: row.b, activeMs: Math.max(0, Date.parse(row.b!) - Date.parse(row.a)) } : null;
}

/** Fallback when no transcript is readable: largest context snapshot T3 saw. */
function contextTokens(threadId: string): number {
  const row = conn()
    .query(
      `select max(json_extract(payload_json, '$.tokenUsage.usedTokens')) as t
       from orchestration_v2_projection_provider_turns where thread_id = ?`,
    )
    .get(threadId) as { t: number | null } | null;
  return row?.t ?? 0;
}

function toolsFromTurnItems(threadId: string): string[] {
  const rows = conn()
    .query(
      `select type, json_extract(payload_json, '$.toolName') as tool from orchestration_v2_projection_turn_items
       where thread_id = ? and type in ('command_execution','dynamic_tool','web_search','file_change','mcp_tool_call')
       order by ordinal`,
    )
    .all(threadId) as { type: string; tool: string | null }[];
  const names = rows.map((r) =>
    r.type === "command_execution" ? "Bash" : r.type === "web_search" ? "WebSearch" : r.type === "file_change" ? "Edit" : (r.tool ?? r.type),
  );
  return [...new Set(names)];
}

function applyUsage(node: AgentNode, refs: NativeRef[]) {
  const seen = new Set<string>();
  let total: Usage | null = null;
  for (const ref of refs) {
    const key = `${ref.driver}:${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = usageFor(ref);
    if (u) total = mergeUsage(total ?? emptyUsage(), u);
  }
  if (total) {
    node.costUsd = total.costUsd;
    node.tokens = total.input + total.cacheRead + total.cacheWrite5m + total.cacheWrite1h + total.output;
    node.usageSource = "transcript";
    node.tools = total.tools;
    if (!node.model && total.models[0]) node.model = total.models[0];
  } else if (node.threadId) {
    node.tokens = contextTokens(node.threadId);
    node.usageSource = node.tokens ? "context" : "none";
  }
  if (!node.tools.length && node.threadId) node.tools = toolsFromTurnItems(node.threadId);
}

const LAUNCH_TOOLS = ["t3_thread_launch", "create_threads", "t3_thread_fork"];

/** Threads created from `threadId` by T3's MCP launch tools, read from the tool results. */
function launchedThreads(threadId: string): { threadId: string; nodeId: string | null }[] {
  const rows = conn()
    .query(
      `select json_extract(payload_json, '$.toolName') as tool, node_id,
              json_extract(payload_json, '$.input') as input, json_extract(payload_json, '$.output') as output
       from orchestration_v2_projection_turn_items
       where thread_id = ? and type = 'dynamic_tool' and status = 'completed'
         and (${LAUNCH_TOOLS.map(() => "json_extract(payload_json, '$.toolName') like ?").join(" or ")})
       order by ordinal`,
    )
    .all(threadId, ...LAUNCH_TOOLS.map((t) => `%${t}`)) as { tool: string; node_id: string | null; input: string | null; output: string | null }[];
  const out: { threadId: string; nodeId: string | null }[] = [];
  for (const r of rows) {
    // A fork's input names the source thread; only ids in the result are new threads.
    const source = parse(r.input).threadId;
    for (const m of (r.output ?? "").matchAll(/\\?"threadId\\?"\s*:\s*\\?"([^"\\]+)/g)) {
      const id = m[1];
      if (id !== threadId && id !== source && !out.some((o) => o.threadId === id)) out.push({ threadId: id, nodeId: r.node_id });
    }
  }
  return out;
}

/** Every thread some other thread launched, so the picker can hide them as roots. */
function allLaunchedThreadIds(): Set<string> {
  const rows = conn()
    .query(
      `select distinct thread_id from orchestration_v2_projection_turn_items
       where type = 'dynamic_tool' and (${LAUNCH_TOOLS.map(() => "json_extract(payload_json, '$.toolName') like ?").join(" or ")})`,
    )
    .all(...LAUNCH_TOOLS.map((t) => `%${t}`)) as { thread_id: string }[];
  const ids = new Set<string>();
  for (const r of rows) for (const l of launchedThreads(r.thread_id)) ids.add(l.threadId);
  return ids;
}

// ---------- tree ----------

type SubRow = {
  subagent_id: string;
  thread_id: string;
  parent_node_id: string;
  provider: string;
  child_thread_id: string | null;
  origin: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  payload_json: string;
  driver: string | null;
};

export function buildTree(rootThreadId: string): AgentNode | null {
  if (isConductorId(rootThreadId)) return buildConductorTree(rootThreadId);
  const root = threadRow(rootThreadId);
  if (!root) return null;
  const rp = parse(root.payload_json);
  const run = threadRunState(rootThreadId) ?? legacyRun(rootThreadId);
  const rootNode: AgentNode = {
    id: `thread:${rootThreadId}`,
    threadId: rootThreadId,
    parentId: null,
    origin: "root",
    provider: rp.providerInstanceId ?? root.default_provider,
    name: root.title,
    model: rp.modelSelection?.model ?? null,
    task: firstLine(firstUserMessage(rootThreadId)) || root.title,
    prompt: firstUserMessage(rootThreadId),
    result: null,
    status: run?.status ?? "done",
    startedAt: run?.startedAt ?? rp.createdAt ?? null,
    completedAt: run?.completedAt ?? null,
    activeMs: run?.activeMs,
    runStartedAt: run?.runStartedAt,
    runs: run?.runs,
    costUsd: null,
    tokens: 0,
    usageSource: "none",
    tools: [],
    children: [],
  };
  applyUsage(rootNode, nativeThreadRefs(rootThreadId));

  const byId = new Map<string, AgentNode>([[rootNode.id, rootNode]]);
  const ownerOfThread = new Map<string, AgentNode>([[rootThreadId, rootNode]]);
  const pending: { node: AgentNode; parentHint: string | null; ownerThread: string }[] = [];
  const queue = [rootThreadId];
  const visited = new Set<string>();

  const subQ = conn().query(
    `select subagent_id, thread_id, parent_node_id, provider, child_thread_id, origin, status,
            started_at, completed_at, payload_json, driver
     from orchestration_v2_projection_subagents where thread_id = ? order by started_at, subagent_id`,
  );
  const lineageQ = conn().query(
    `select thread_id, title, default_provider, updated_at, payload_json from orchestration_v2_projection_threads
     where json_extract(payload_json, '$.lineage.parentThreadId') = ? and deleted_at is null order by created_at`,
  );

  while (queue.length) {
    const tid = queue.shift()!;
    if (visited.has(tid)) continue;
    visited.add(tid);

    const childThreadsFromSubs = new Set<string>();
    for (const s of subQ.all(tid) as SubRow[]) {
      const p = parse(s.payload_json);
      const driver = s.driver ?? p.driver ?? s.provider;
      const nativeId: string | undefined = p.nativeTaskRef?.nativeId;
      const meta = driver === "claudeAgent" && nativeId ? claudeAgentMeta(nativeId) : null;
      const title: string = p.title ?? p.progress ?? "Subagent";
      const name = meta?.agentType ? prettyName(meta.agentType) : prettyName(title);
      const node: AgentNode = {
        id: s.subagent_id,
        threadId: s.child_thread_id,
        parentId: null,
        origin: s.origin === "app_owned" ? "app_owned" : "provider_native",
        provider: driver,
        name,
        model: p.model ?? p.modelSelection?.model ?? null,
        task: name.toLowerCase() === prettyName(title).toLowerCase() ? firstLine(p.prompt) || title : title,
        prompt: p.prompt ?? null,
        result: p.result ?? null,
        status: mapStatus(s.status),
        startedAt: s.started_at,
        completedAt: s.completed_at,
        costUsd: null,
        tokens: 0,
        usageSource: "none",
        tools: [],
        children: [],
      };
      const refs: NativeRef[] = s.child_thread_id ? nativeThreadRefs(s.child_thread_id) : [];
      if (nativeId) refs.push({ driver, kind: "task", id: nativeId });
      applyUsage(node, refs);
      byId.set(node.id, node);
      if (s.child_thread_id) {
        ownerOfThread.set(s.child_thread_id, node);
        childThreadsFromSubs.add(s.child_thread_id);
        queue.push(s.child_thread_id);
      }
      pending.push({ node, parentHint: s.parent_node_id, ownerThread: tid });
    }

    // Threads this one started that aren't subagents: lineage children (forks, handoffs) and threads
    // created through T3's MCP tools (t3_thread_launch / create_threads), which carry no lineage.
    const started: { t: ThreadRow; hint: string | null }[] = (lineageQ.all(tid) as ThreadRow[]).map((t) => ({ t, hint: null }));
    for (const l of launchedThreads(tid)) {
      const t = threadRow(l.threadId);
      if (t) started.push({ t, hint: l.nodeId });
    }
    for (const { t, hint } of started) {
      if (childThreadsFromSubs.has(t.thread_id) || ownerOfThread.has(t.thread_id) || t.thread_id === rootThreadId) continue;
      const tp = parse(t.payload_json);
      const r = threadRunState(t.thread_id) ?? legacyRun(t.thread_id);
      const node: AgentNode = {
        id: `thread:${t.thread_id}`,
        threadId: t.thread_id,
        parentId: null,
        origin: "thread",
        provider: tp.providerInstanceId ?? t.default_provider,
        name: t.title,
        model: tp.modelSelection?.model ?? null,
        task: firstLine(firstUserMessage(t.thread_id)) || t.title,
        prompt: firstUserMessage(t.thread_id),
        result: null,
        status: r?.status ?? "done",
        startedAt: r?.startedAt ?? tp.createdAt ?? null,
        completedAt: r?.completedAt ?? null,
        activeMs: r?.activeMs,
        runStartedAt: r?.runStartedAt,
        runs: r?.runs,
        costUsd: null,
        tokens: 0,
        usageSource: "none",
        tools: [],
        children: [],
      };
      applyUsage(node, nativeThreadRefs(t.thread_id));
      byId.set(node.id, node);
      ownerOfThread.set(t.thread_id, node);
      pending.push({ node, parentHint: hint, ownerThread: tid });
      queue.push(t.thread_id);
    }
  }

  // Resolve parents: the parent node may be another subagent, or any node living inside an agent's thread.
  const nodeThreadQ = conn().query(`select thread_id from orchestration_v2_projection_nodes where node_id = ?`);
  for (const { node, parentHint, ownerThread } of pending) {
    let parent = parentHint ? byId.get(parentHint) : undefined;
    if (!parent && parentHint) {
      const row = nodeThreadQ.get(parentHint) as { thread_id: string } | null;
      if (row) parent = ownerOfThread.get(row.thread_id);
    }
    parent ??= ownerOfThread.get(ownerThread) ?? rootNode;
    if (parent === node) parent = rootNode;
    node.parentId = parent.id;
    parent.children.push(node);
  }
  return rootNode;
}

/** T3's newest threads, then Conductor's history (all of it: nothing new arrives there). */
export function listThreads(limit = 60): ThreadSummary[] {
  let conductor: ThreadSummary[] = [];
  try {
    conductor = listConductorThreads();
  } catch (e) {
    console.warn(`Conductor history unavailable: ${e}`); // never hide T3's own threads
  }
  return [...listT3Threads(limit), ...conductor];
}

function listT3Threads(limit: number): ThreadSummary[] {
  const rows = conn()
    .query(
      `select t.thread_id, t.title, t.default_provider, t.updated_at, t.project_id,
              (select count(*) from orchestration_v2_projection_subagents s where s.thread_id = t.thread_id) as subs,
              exists(select 1 from orchestration_v2_projection_runs r where r.thread_id = t.thread_id and r.status = 'running') as running
       from orchestration_v2_projection_threads t
       where t.deleted_at is null and t.archived_at is null
         and json_extract(t.payload_json, '$.lineage.parentThreadId') is null
       order by t.updated_at desc limit ?`,
    )
    .all(limit + 40) as {
    thread_id: string;
    title: string;
    default_provider: string;
    updated_at: string;
    project_id: string;
    subs: number;
    running: number;
  }[];
  const projects = projectMap();
  const launched = allLaunchedThreadIds();
  const children = (id: string) =>
    (conn().query(`select count(*) as n from orchestration_v2_projection_threads where json_extract(payload_json, '$.lineage.parentThreadId') = ?
         and coalesce(json_extract(payload_json, '$.lineage.relationshipToParent'), '') != 'subagent'`).get(id) as { n: number }).n;
  return rows.filter((r) => !launched.has(r.thread_id)).slice(0, limit).map((r) => ({
    threadId: r.thread_id,
    title: r.title,
    provider: r.default_provider,
    updatedAt: r.updated_at,
    agents: r.subs + children(r.thread_id) + launchedThreads(r.thread_id).length,
    running: !!r.running,
    projectId: r.project_id,
    project: projects.get(r.project_id)?.title ?? "Unknown project",
    workspaceRoot: projects.get(r.project_id)?.root ?? null,
  }));
}

// ---------- projects ----------

function projectMap() {
  const rows = conn().query(`select project_id, title, workspace_root from projection_projects`).all() as {
    project_id: string;
    title: string;
    workspace_root: string;
  }[];
  return new Map(rows.map((r) => [r.project_id, { title: r.title, root: r.workspace_root }]));
}

const COMM_TOOLS: [string, ThreadLink["kind"]][] = [
  ["t3_thread_send", "message"],
  ["t3_thread_read", "read"],
  ["t3_thread_wait", "read"],
];

/**
 * Every top-level thread in a T3 project (= a directory, worktrees included) as one forest under a
 * project card, plus the thread-to-thread calls between them.
 */
export function buildProject(projectId: string, limit = 12): AgentNode | null {
  if (isConductorId(projectId)) return buildConductorProject(projectId, limit);
  const meta = projectMap().get(projectId);
  if (!meta) return null;
  const launched = allLaunchedThreadIds();
  const ids = (
    conn()
      .query(
        `select thread_id from orchestration_v2_projection_threads
         where project_id = ? and deleted_at is null and archived_at is null
           and json_extract(payload_json, '$.lineage.parentThreadId') is null
         order by updated_at desc`,
      )
      .all(projectId) as { thread_id: string }[]
  )
    .map((r) => r.thread_id)
    .filter((id) => !launched.has(id))
    .slice(0, limit)
    .reverse(); // oldest first, left to right
  const threads = ids.map((id) => buildTree(id)).filter((t): t is AgentNode => !!t);

  const project: AgentNode = {
    id: `project:${projectId}`,
    threadId: null,
    parentId: null,
    origin: "project",
    provider: "project",
    name: meta.title,
    model: meta.root.replace(homedir(), "~"),
    task: `${threads.length} thread${threads.length === 1 ? "" : "s"}`,
    prompt: meta.root,
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

  // threadId -> card, across every tree in the project.
  const cardOf = new Map<string, string>();
  const walk = (n: AgentNode) => {
    if (n.threadId) cardOf.set(n.threadId, n.id);
    n.children.forEach(walk);
  };
  threads.forEach(walk);

  const allThreads = [...cardOf.keys()];
  if (allThreads.length) {
    const rows = conn()
      .query(
        `select thread_id as caller, json_extract(payload_json, '$.toolName') as tool,
                json_extract(payload_json, '$.input.threadId') as target,
                count(*) as n, min(json_extract(payload_json, '$.startedAt')) as at
         from orchestration_v2_projection_turn_items
         where type = 'dynamic_tool' and thread_id in (${allThreads.map(() => "?").join(",")})
           and json_extract(payload_json, '$.input.threadId') is not null
         group by 1, 2, 3`,
      )
      .all(...allThreads) as { caller: string; tool: string; target: string; n: number; at: string }[];
    const merged = new Map<string, ThreadLink>();
    for (const r of rows) {
      const kind = COMM_TOOLS.find(([t]) => r.tool?.endsWith(t))?.[1];
      const from = cardOf.get(r.caller);
      const to = cardOf.get(r.target);
      if (!kind || !from || !to || from === to) continue;
      const key = `${from}>${to}>${kind}`;
      const link = merged.get(key);
      if (link) {
        link.count += r.n;
        if (r.at < link.at) link.at = r.at;
      } else merged.set(key, { from, to, kind, count: r.n, at: r.at });
    }
    project.links = [...merged.values()];
  }
  return project;
}

/** Most interesting thread to show by default: newest one with subagents, preferring a running one. */
export function defaultThreadId(): string | null {
  const all = listT3Threads(40);
  return (all.find((t) => t.running && t.agents) ?? all.find((t) => t.agents) ?? all[0])?.threadId ?? null;
}
