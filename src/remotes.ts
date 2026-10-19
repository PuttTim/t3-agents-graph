// Federation: other machines (e.g. ones connected through T3 Connect) each run this server,
// and the one you open merges their threads in. T3 Connect itself is an encrypted, signed relay
// with no public API, so we talk to our own server on each machine instead.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentNode, ThreadSummary } from "./t3";

export type Remote = { name: string; url: string; token?: string };

const CONFIG = process.env.AGENT_GRAPH_REMOTES_FILE ?? join(import.meta.dir, "..", "remotes.json");

/** From AGENT_GRAPH_REMOTES="Studio=http://studio:4317,http://pc:4317" or remotes.json [{name,url,token?}]. */
export function loadRemotes(): Remote[] {
  const env = process.env.AGENT_GRAPH_REMOTES;
  if (env) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [name, url] = s.includes("=") ? s.split("=", 2) : [new URL(s).hostname, s];
        return { name, url: url.replace(/\/$/, ""), token: process.env.AGENT_GRAPH_TOKEN };
      });
  }
  if (!existsSync(CONFIG)) return [];
  try {
    return (JSON.parse(readFileSync(CONFIG, "utf8")) as Remote[]).map((r) => ({
      ...r,
      url: r.url.replace(/\/$/, ""),
      token: r.token ?? process.env.AGENT_GRAPH_TOKEN,
    }));
  } catch (e) {
    console.error(`Ignoring ${CONFIG}: ${e}`);
    return [];
  }
}

async function get<T>(remote: Remote, path: string): Promise<T> {
  const res = await fetch(`${remote.url}${path}`, {
    headers: remote.token ? { authorization: `Bearer ${remote.token}` } : {},
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`${remote.name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export type RemoteThreads = { remote: Remote; threads: ThreadSummary[]; t3EnvironmentId: string | null; error: string | null };

// Thread lists change slowly; cache them so the 1s SSE tick doesn't hammer every machine.
const listCache = new Map<string, { at: number; value: RemoteThreads }>();

const inflight = new Map<string, Promise<RemoteThreads>>();

/** Stale-while-revalidate, so a slow or offline machine never holds up the 1s tick after the first load. */
export async function remoteThreads(remote: Remote): Promise<RemoteThreads> {
  const hit = listCache.get(remote.url);
  if (hit && Date.now() - hit.at < 5000) return hit.value;
  if (!inflight.has(remote.url)) {
    inflight.set(remote.url, refreshThreads(remote).finally(() => inflight.delete(remote.url)));
  }
  return hit ? hit.value : inflight.get(remote.url)!;
}

async function refreshThreads(remote: Remote): Promise<RemoteThreads> {
  const hit = listCache.get(remote.url);
  let value: RemoteThreads;
  try {
    const [threads, info] = await Promise.all([
      get<ThreadSummary[]>(remote, "/api/local/threads"),
      // Older servers don't have /api/local/info: no "Open in T3" links for them, nothing else breaks.
      get<{ t3EnvironmentId?: string | null }>(remote, "/api/local/info").catch(() => null),
    ]);
    const t3EnvironmentId = info?.t3EnvironmentId ?? hit?.value.t3EnvironmentId ?? null;
    value = { remote, threads, t3EnvironmentId, error: null };
  } catch (e) {
    value = { remote, threads: hit?.value.threads ?? [], t3EnvironmentId: hit?.value.t3EnvironmentId ?? null, error: String((e as Error).message ?? e) };
  }
  listCache.set(remote.url, { at: Date.now(), value });
  return value;
}

export async function remoteTree(remote: Remote, threadId: string): Promise<AgentNode | null> {
  return get<AgentNode | null>(remote, `/api/local/tree?thread=${encodeURIComponent(threadId)}`);
}

export async function remoteProject(remote: Remote, projectId: string): Promise<AgentNode | null> {
  return get<AgentNode | null>(remote, `/api/local/project?id=${encodeURIComponent(projectId)}`);
}
