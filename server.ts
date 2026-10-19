import { buildProject, buildTree, defaultThreadId, listThreads } from "./src/t3";
import { loadRemotes, remoteProject, remoteThreads, remoteTree } from "./src/remotes";
import { hostname } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 4317);
// Localhost only by default: the API serves your prompts and results. Set HOST=0.0.0.0 (plus
// AGENT_GRAPH_TOKEN) on a machine that other machines should read from.
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.AGENT_GRAPH_TOKEN ?? "";
const LOCAL_NAME = process.env.AGENT_GRAPH_NAME ?? hostname().replace(/\.local$/, "");
const PUBLIC = join(import.meta.dir, "public");
const TICK_MS = 1000;

const remotes = loadRemotes();

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function authorized(req: Request, url: URL) {
  if (!TOKEN) return true;
  return req.headers.get("authorization") === `Bearer ${TOKEN}` || url.searchParams.get("token") === TOKEN;
}

type Env = { id: string; name: string; error: string | null };

async function snapshot(envId: string | null, threadId: string | null, projectId: string | null = null) {
  const lists = await Promise.all(remotes.map(remoteThreads));
  const envs: Env[] = [{ id: "local", name: LOCAL_NAME, error: null }].concat(
    lists.map((l) => ({ id: l.remote.name, name: l.remote.name, error: l.error })),
  );
  const threads = listThreads().map((t) => ({ ...t, env: "local" }));
  for (const l of lists) threads.push(...l.threads.map((t) => ({ ...t, env: l.remote.name })));

  let env = envId || "local";
  let id = threadId;
  if (projectId) {
    const remote = remotes.find((r) => r.name === env);
    let tree = null;
    let error: string | null = null;
    if (env !== "local" && !remote) error = `Unknown machine "${env}"`;
    else
      try {
        tree = remote ? await remoteProject(remote, projectId) : buildProject(projectId);
        if (!tree) error = "Project not found";
      } catch (e) {
        error = String((e as Error).message ?? e);
      }
    return { env, threadId: null, projectId, tree, threads, envs, error };
  }
  if (!id) {
    // "Latest active": newest running thread with agents on any machine, else the local default.
    const live = threads.filter((t) => t.running && t.agents).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (live) ({ env, threadId: id } = live);
    else ((env = "local"), (id = defaultThreadId()));
  }

  let tree = null;
  let error: string | null = null;
  if (id) {
    const remote = remotes.find((r) => r.name === env);
    if (env !== "local" && !remote) error = `Unknown machine "${env}"`;
    else if (remote) {
      try {
        tree = await remoteTree(remote, id);
      } catch (e) {
        error = String((e as Error).message ?? e);
      }
    } else tree = buildTree(id);
  }
  return { env, threadId: id, projectId: null, tree, threads, envs, error };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") && !authorized(req, url)) return json({ error: "unauthorized" }, 401);

    // What other machines read from this one (no federation, so no loops).
    if (url.pathname === "/api/local/threads") return json(listThreads());
    if (url.pathname === "/api/local/project") {
      const id = url.searchParams.get("id");
      return json(id ? buildProject(id) : null);
    }
    if (url.pathname === "/api/local/tree") {
      const id = url.searchParams.get("thread");
      return json(id ? buildTree(id) : null);
    }

    if (url.pathname === "/api/tree") {
      try {
        const q = url.searchParams;
        return json(await snapshot(q.get("env"), q.get("thread"), q.get("project")));
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // Server-sent events: pushes a fresh snapshot whenever anything changes.
    if (url.pathname === "/api/stream") {
      const env = url.searchParams.get("env");
      const thread = url.searchParams.get("thread");
      const project = url.searchParams.get("project");
      let timer: Timer;
      let closed = false;
      const stream = new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder();
          let last = "";
          let busy = false;
          const push = async () => {
            if (busy || closed) return;
            busy = true;
            try {
              const body = JSON.stringify(await snapshot(env, thread, project));
              if (closed) return;
              if (body !== last) {
                last = body;
                ctrl.enqueue(enc.encode(`data: ${body}\n\n`));
              } else ctrl.enqueue(enc.encode(`: ping\n\n`));
            } catch (e) {
              if (!closed) ctrl.enqueue(enc.encode(`event: failure\ndata: ${JSON.stringify(String(e))}\n\n`));
            } finally {
              busy = false;
            }
          };
          push();
          timer = setInterval(push, TICK_MS);
        },
        cancel() {
          closed = true;
          clearInterval(timer);
        },
      });
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(timer);
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(PUBLIC, path.replace(/\.\.+/g, "")));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

console.log(`Agent tree -> http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${server.port}  (${LOCAL_NAME})`);
if (remotes.length) console.log(`Reading from: ${remotes.map((r) => `${r.name} (${r.url})`).join(", ")}`);
if (HOST !== "127.0.0.1" && !TOKEN) console.warn("Warning: listening beyond localhost without AGENT_GRAPH_TOKEN.");
