import { buildTree, defaultThreadId, listThreads } from "./src/t3";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 4317);
// Localhost only by default: the API serves your prompts and results.
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC = join(import.meta.dir, "public");
const TICK_MS = 1000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function snapshot(threadId: string | null) {
  const id = threadId || defaultThreadId();
  return { threadId: id, tree: id ? buildTree(id) : null, threads: listThreads() };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/threads") return json(listThreads());

    if (url.pathname === "/api/tree") {
      try {
        return json(snapshot(url.searchParams.get("thread")));
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // Server-sent events: pushes a fresh snapshot whenever anything changes.
    if (url.pathname === "/api/stream") {
      const thread = url.searchParams.get("thread");
      let timer: Timer;
      const stream = new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder();
          let last = "";
          const push = () => {
            try {
              const body = JSON.stringify(snapshot(thread));
              if (body !== last) {
                last = body;
                ctrl.enqueue(enc.encode(`data: ${body}\n\n`));
              } else ctrl.enqueue(enc.encode(`: ping\n\n`));
            } catch (e) {
              ctrl.enqueue(enc.encode(`event: failure\ndata: ${JSON.stringify(String(e))}\n\n`));
            }
          };
          push();
          timer = setInterval(push, TICK_MS);
        },
        cancel() {
          clearInterval(timer);
        },
      });
      req.signal.addEventListener("abort", () => clearInterval(timer));
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(PUBLIC, path.replace(/\.\.+/g, "")));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

console.log(`Agent tree -> http://${HOST}:${server.port}`);
