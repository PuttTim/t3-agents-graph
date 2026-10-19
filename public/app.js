import { chevron, providerIcon, statusMeta, toolBadges } from "./icons.js";
import { startDemo } from "./demo.js";
import { buildTimeline, timeAt, treeAt } from "./replay.js";

const W = 300; // keep in sync with --card-w
const H = 136; // --card-h
const ROW_GAP = 60; // root bottom -> first row top
const COL_GAP = 24;
const STACK_GAP = 14;
const INDENT = 28;
const ELBOW_X = 20; // where the vertical wire leaves a card, from its left edge
const PAD = 32;

const $ = (s) => document.querySelector(s);
const viewport = $("#viewport");
const canvas = $("#canvas");
const wires = $("#wires");
const select = $("#thread");
const params = new URLSearchParams(location.search);

const state = {
  tree: null,
  threads: [],
  threadId: params.get("thread") ?? "",
  env: params.get("env") ?? "",
  projectId: params.get("project") ?? "",
  groupBy: localStorage.getItem("agents-group-by") ?? "project",
  layout: localStorage.getItem("agents-layout") ?? "horizontal",
  envs: [],
  collapsed: new Set(),
  selected: null,
  cards: new Map(),
  wireEls: new Map(),
  dotEls: new Map(),
  commEls: new Map(),
  firstPaint: true,
};

// ---------- theme ----------

const savedTheme = localStorage.getItem("agents-theme");
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = (t) => (document.documentElement.dataset.theme = t);
applyTheme(savedTheme ?? (systemDark.matches ? "dark" : "light"));
systemDark.addEventListener("change", (e) => !localStorage.getItem("agents-theme") && applyTheme(e.matches ? "dark" : "light"));
$("#theme").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("agents-theme", next);
  applyTheme(next);
};

// ---------- formatting ----------

const MODEL_NAMES = [
  [/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)-(\d+)/i, (m) => `${cap(m[1])} ${m[2]}.${m[3]}`],
  [/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)/i, (m) => `${cap(m[1])} ${m[2]}`],
  [/^gpt-([\d.]+)-?(.*)$/i, (m) => `GPT-${m[1]}${m[2] ? " " + m[2].split("-").map(cap).join(" ") : ""}`],
  [/^gemini-([\d.]+)-?(.*)$/i, (m) => `Gemini ${m[1]}${m[2] ? " " + m[2].split("-").map(cap).join(" ") : ""}`],
];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function modelLabel(model, provider) {
  if (!model) return { claudeAgent: "Claude", codex: "Codex", opencode: "OpenCode", cursor: "Cursor" }[provider] ?? provider ?? "";
  const bare = model.replace(/^.*\//, "").replace(/\[.*\]$/, "");
  for (const [re, f] of MODEL_NAMES) {
    const m = bare.match(re);
    if (m) return f(m);
  }
  return bare;
}

// Wall clock, or the replay's thread clock while a replay is playing.
const clock = () => (replay ? replay.t : Date.now());

function duration(node, now = clock()) {
  let ms;
  if (node.activeMs != null) ms = node.activeMs + (node.runStartedAt ? now - Date.parse(node.runStartedAt) : 0);
  else if (node.startedAt) ms = (node.completedAt ? Date.parse(node.completedAt) : now) - Date.parse(node.startedAt);
  else return "";
  let s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  s %= 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** " · 45s" after the cost, or just "45s" when there's no cost to separate it from. */
function footDuration(n) {
  const d = duration(n);
  const t = n._total;
  return d && (t.priced || t.tok) ? ` · ${d}` : d;
}

const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`) + " tok";

/** Cost of a node including everything it started (like the original: parent cost rolls up). */
function rollup(node) {
  let cost = node.costUsd ?? 0;
  let priced = node.costUsd != null;
  let tok = node.tokens ?? 0;
  for (const c of node.children) {
    const r = rollup(c);
    cost += r.cost;
    priced ||= r.priced;
    tok += r.tok;
  }
  node._total = { cost, priced, tok };
  return node._total;
}

const money = (n) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`;
const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function walk(node, f, depth = 0, parent = null) {
  f(node, depth, parent);
  for (const c of node.children) walk(c, f, depth + 1, node);
}

// ---------- layout ----------
// Root on top, its children side by side, everything deeper stacks downward in an indented list.

const visibleKids = (n) => (state.collapsed.has(n.id) ? [] : n.children);

function layout(root) {
  return state.layout === "vertical" ? layoutStacked(root) : layoutSpread(root);
}

// Horizontal: every level side by side, each parent centred over its children (an org chart).
function layoutSpread(root) {
  const pos = new Map();
  const links = [];
  const widthOf = new Map();
  const measure = (n) => {
    const ks = visibleKids(n);
    const inner = ks.reduce((s, k) => s + measure(k), 0) + COL_GAP * Math.max(0, ks.length - 1);
    const w = Math.max(W, inner);
    widthOf.set(n.id, w);
    return w;
  };
  const total = measure(root);
  let maxY = 0;
  const place = (n, x0, depth) => {
    const w = widthOf.get(n.id);
    const y = PAD + depth * (H + ROW_GAP);
    pos.set(n.id, { x: x0 + (w - W) / 2, y });
    maxY = Math.max(maxY, y + H);
    const ks = visibleKids(n);
    const inner = ks.reduce((s, k) => s + widthOf.get(k.id), 0) + COL_GAP * Math.max(0, ks.length - 1);
    let x = x0 + (w - inner) / 2;
    for (const k of ks) {
      place(k, x, depth + 1);
      links.push({ id: `${n.id}->${k.id}`, from: n, to: k, top: true });
      x += widthOf.get(k.id) + COL_GAP;
    }
  };
  place(root, PAD, 0);
  return { pos, links, width: total + PAD * 2, height: maxY + PAD };
}

// Vertical (as in the original clip): root's children side by side, everything deeper stacked and indented.
function layoutStacked(root) {
  const pos = new Map();
  const links = [];

  const cols = visibleKids(root).map((child) => {
    const items = [];
    const flatten = (n, d) => {
      items.push({ n, d });
      for (const k of visibleKids(n)) flatten(k, d + 1);
    };
    flatten(child, 0);
    return { child, items, width: W + Math.max(...items.map((i) => i.d)) * INDENT };
  });

  const rowW = cols.reduce((s, c) => s + c.width, 0) + COL_GAP * Math.max(0, cols.length - 1);
  const totalW = Math.max(W, rowW);
  const rootX = PAD + (totalW - W) / 2;
  pos.set(root.id, { x: rootX, y: PAD });

  const rowY = PAD + H + ROW_GAP;
  let x = PAD + (totalW - rowW) / 2;
  let maxY = PAD + H;
  for (const col of cols) {
    col.items.forEach(({ n, d }, i) => {
      const y = rowY + i * (H + STACK_GAP);
      pos.set(n.id, { x: x + d * INDENT, y });
      maxY = Math.max(maxY, y + H);
    });
    x += col.width + COL_GAP;
  }

  walk(root, (n, _d, parent) => {
    if (!parent || !pos.has(n.id) || !pos.has(parent.id)) return;
    links.push({ id: `${parent.id}->${n.id}`, from: parent, to: n, top: parent === root });
  });

  return { pos, links, width: totalW + PAD * 2, height: maxY + PAD };
}

function wirePath(link, pos) {
  const a = pos.get(link.from.id);
  const b = pos.get(link.to.id);
  const r = 8;
  if (link.top) {
    const ax = a.x + W / 2;
    const ay = a.y + H;
    const bx = b.x + W / 2;
    const barY = b.y - 22;
    if (Math.abs(ax - bx) < 1) return `M${ax},${ay} V${b.y}`;
    const dir = bx > ax ? 1 : -1;
    return `M${ax},${ay} V${barY} H${bx - dir * r} Q${bx},${barY} ${bx},${barY + r} V${b.y}`;
  }
  const ax = a.x + ELBOW_X;
  const ay = a.y + H;
  const cy = b.y + H / 2;
  const rr = Math.min(r, b.x - ax);
  return `M${ax},${ay} V${cy - rr} Q${ax},${cy} ${ax + rr},${cy} H${b.x}`;
}

// ---------- rendering ----------

function cardEl(node) {
  let el = state.cards.get(node.id);
  if (el) return el;
  el = document.createElement("div");
  el.className = state.firstPaint ? "card" : "card enter";
  el.innerHTML = `
    <div class="head">
      <div class="tile"></div>
      <div class="who"><div class="name"></div><div class="model"></div></div>
      <span class="pill"></span>
    </div>
    <div class="task"><span class="tools"></span><span class="text"></span></div>
    <div class="foot"><span><b class="cost"></b><span class="dur"></span></span><button class="kids" hidden></button></div>`;
  el.addEventListener("click", (e) => {
    if (e.target.closest(".kids")) return;
    openDrawer(node.id);
  });
  el.querySelector(".kids").addEventListener("click", () => {
    state.collapsed.has(node.id) ? state.collapsed.delete(node.id) : state.collapsed.add(node.id);
    render();
  });
  canvas.appendChild(el);
  state.cards.set(node.id, el);
  return el;
}

function setAttr(el, name, v) {
  if (el.getAttribute(name) !== String(v)) el.setAttribute(name, v);
}
function setText(el, sel, v) {
  const t = el.querySelector(sel);
  if (t.textContent !== v) t.textContent = v;
}
function setHTML(el, sel, v) {
  const t = el.querySelector(sel);
  if (t._html !== v) {
    t.innerHTML = v;
    t._html = v;
  }
}

function updateCard(el, node, p) {
  const tf = `translate(${p.x}px, ${p.y}px)`;
  if (el.style.transform !== tf) el.style.transform = tf;
  el.classList.toggle("stopped", node.status === "stopped");
  el.classList.toggle("selected", state.selected === node.id);
  setHTML(el, ".tile", providerIcon(node.provider, node.model));
  setText(el, ".name", node.name);
  setText(el, ".model", node.origin === "project" ? node.model ?? "" : modelLabel(node.model, node.provider));
  const st = statusMeta[node.status] ?? statusMeta.done;
  const pill = el.querySelector(".pill");
  if (pill.className !== `pill ${node.status}`) pill.className = `pill ${node.status}`;
  setHTML(el, ".pill", `${st.icon}${st.label}`);
  setHTML(el, ".tools", toolBadges(node.tools));
  setText(el, ".text", node.task);
  setAttr(el.querySelector(".task"), "title", node.prompt ?? node.task);
  const t = node._total;
  setText(el, ".cost", t.priced ? money(t.cost) : t.tok ? tokens(t.tok) : "");
  setText(el, ".dur", footDuration(node));
  const kids = el.querySelector(".kids");
  kids.hidden = node.children.length === 0;
  kids.classList.toggle("collapsed", state.collapsed.has(node.id));
  setHTML(el, ".kids", `${node.children.length} ${chevron}`);
}

function render() {
  const root = state.tree;
  $("#empty").hidden = !!root;
  if (!root) {
    for (const el of state.cards.values()) el.remove();
    state.cards.clear();
    wires.innerHTML = "";
    state.wireEls.clear();
    state.dotEls.clear();
  state.commEls.clear();
    $("#empty").innerHTML = state.threads.length
      ? "No thread selected."
      : "No T3 Code threads found.<br><code>Looking in ~/.t3/userdata/statev2.sqlite</code>";
    return;
  }

  // A project card is running while any of its threads is.
  if (root.origin === "project") root.status = root.children.some((c) => c.status === "running") ? "running" : "done";
  rollup(root);
  // A replay lays out the finished tree so cards appear in their final spot instead of reflowing.
  const full = layout(replay ? replay.source : root);
  const shown = new Set();
  walk(root, (n) => shown.add(n.id));
  const { pos, height } = full;
  const width = full.width + (root.links?.length ? 90 : 0); // room for link arcs bulging right
  const links = full.links.filter((l) => shown.has(l.from.id) && shown.has(l.to.id));
  if (canvas.style.width !== `${width}px`) canvas.style.width = `${width}px`;
  if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
  setAttr(wires, "width", width);
  setAttr(wires, "height", height);

  // cards
  const live = new Set();
  walk(root, (n) => {
    const p = pos.get(n.id);
    if (!p) return;
    live.add(n.id);
    updateCard(cardEl(n), n, p);
  });
  for (const [id, el] of state.cards) {
    if (!live.has(id)) {
      el.remove();
      state.cards.delete(id);
    }
  }

  // wires + dots where a card's children leave
  const liveWires = new Set();
  for (const l of links) {
    liveWires.add(l.id);
    let path = state.wireEls.get(l.id);
    const d = wirePath(l, pos);
    if (!path) {
      path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      wires.prepend(path);
      state.wireEls.set(l.id, path);
      path.setAttribute("d", d);
      if (!state.firstPaint) {
        path.style.setProperty("--len", Math.ceil(path.getTotalLength()));
        path.classList.add("enter");
        path.addEventListener("animationend", () => path.classList.remove("enter"), { once: true });
      }
    } else if (path.getAttribute("d") !== d) path.setAttribute("d", d);
  }
  for (const [id, el] of state.wireEls) {
    if (!liveWires.has(id)) {
      el.remove();
      state.wireEls.delete(id);
    }
  }
  // Dots where a card's children leave it. Keyed and diffed, since a replay renders 20x a second.
  const dots = new Map(links.map((l) => [l.from.id, l.from]));
  for (const [id, c] of state.dotEls) {
    if (!dots.has(id)) {
      c.remove();
      state.dotEls.delete(id);
    }
  }
  for (const [id] of dots) {
    const p = pos.get(id);
    let c = state.dotEls.get(id);
    if (!c) {
      c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("r", 3.5);
      wires.appendChild(c);
      state.dotEls.set(id, c);
    }
    setAttr(c, "cx", id === root.id || state.layout !== "vertical" ? p.x + W / 2 : p.x + ELBOW_X);
    setAttr(c, "cy", p.y + H);
  }

  renderComm(root, pos, shown);

  // header
  let count = 0;
  let running = 0;
  walk(root, (n) => {
    count++;
    if (n.status === "running") running++;
  });
  $("#stat-count").textContent = `${count} agent${count === 1 ? "" : "s"}`;
  $("#stat-running").textContent = running ? `${running} running` : "";
  $("#stat-cost").textContent = root._total.priced ? money(root._total.cost) : root._total.tok ? tokens(root._total.tok) : "";
  document.title = running ? `(${running}) Agents · ${root.name}` : `Agents · ${root.name}`;

  if (state.firstPaint || state.refit) {
    state.firstPaint = false;
    state.refit = false;
    // Zoom out to fit wide trees (down to 50%), then centre on the root.
    setZoom(Math.max(0.5, Math.min(1, (viewport.clientWidth - 8) / width)));
    requestAnimationFrame(() => {
      const rootPos = pos.get(root.id);
      viewport.scrollLeft = (rootPos.x + W / 2) * state.zoom - viewport.clientWidth / 2;
    });
  }
  if (state.selected) renderDrawer();
}

// ---------- thread-to-thread links (project view) ----------

const COMM_LABEL = { message: "messaged", read: "read" };

function commPath(a, b, i, rightEdge) {
  const ay = a.y + H / 2;
  const by = b.y + H / 2;
  if (Math.abs(a.x - b.x) < W) {
    // Same column: bulge out past every card between the two (indented ones stick out further).
    const ax = a.x + W;
    const bx = b.x + W;
    const x = rightEdge(Math.min(a.y, b.y), Math.max(a.y, b.y) + H) + 28 + i * 26;
    // A cubic only reaches ~3/4 of the way to its control points, so push them out to clear the edge.
    const cx = Math.max(ax, bx) + (x - Math.max(ax, bx)) * 1.34;
    return { d: `M${ax},${ay} C${cx},${ay} ${cx},${by} ${bx},${by}`, lx: x, ly: (ay + by) / 2 + i * 20 };
  }
  // Different columns: leave the caller's side, run across, then turn down into the target's top
  // (or up into its bottom), so the arc travels through the gaps between rows.
  const right = b.x > a.x;
  const sx = right ? a.x + W : a.x;
  const sy = ay + i * 16;
  const below = b.y > a.y;
  const ex = b.x + W / 2 + (right ? -1 : 1) * (W / 4 - i * 18);
  const ey = below ? b.y : b.y + H;
  return {
    d: `M${sx},${sy} C${ex},${sy} ${ex},${sy} ${ex},${ey}`,
    lx: (sx + ex) / 2,
    ly: sy - 6,
  };
}

function renderComm(root, pos, shown) {
  if (!wires.querySelector("defs")) {
    wires.insertAdjacentHTML(
      "afterbegin",
      `<defs>${Object.keys(COMM_LABEL)
        .map((k) => `<marker id="arrow-${k}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0.5 L7.5,4 L0,7.5z" class="arrow ${k}"/></marker>`)
        .join("")}</defs>`,
    );
  }
  const links = (root.links ?? []).filter(
    (l) => shown.has(l.from) && shown.has(l.to) && pos.has(l.from) && pos.has(l.to) && (!replay || Date.parse(l.at) <= replay.t),
  );
  // Rightmost card edge within a vertical band, so same-column arcs clear everything in between.
  const boxes = [...shown].map((id) => pos.get(id)).filter(Boolean);
  const rightEdge = (y0, y1) => Math.max(...boxes.filter((p) => p.y < y1 && p.y + H > y0).map((p) => p.x + W));
  const seen = new Set();
  const pairIndex = new Map();
  for (const l of links) {
    const id = `${l.from}~${l.to}~${l.kind}`;
    seen.add(id);
    const pair = [l.from, l.to].sort().join("~");
    const i = pairIndex.get(pair) ?? 0;
    pairIndex.set(pair, i + 1);
    const { d, lx, ly } = commPath(pos.get(l.from), pos.get(l.to), i, rightEdge);
    let g = state.commEls.get(id);
    if (!g) {
      g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", `comm ${l.kind}`);
      g.innerHTML = `<title></title><path marker-end="url(#arrow-${l.kind})"/><text></text>`;
      wires.appendChild(g);
      state.commEls.set(id, g);
    }
    setAttr(g.querySelector("path"), "d", d);
    const text = g.querySelector("text");
    setAttr(text, "x", lx);
    setAttr(text, "y", ly - 4);
    const label = `${COMM_LABEL[l.kind]} ${l.count}×`;
    if (text.textContent !== label) text.textContent = label;
    const title = `${findNode(l.from)?.name} ${COMM_LABEL[l.kind]} ${findNode(l.to)?.name} ${l.count} time${l.count === 1 ? "" : "s"}`;
    if (g.querySelector("title").textContent !== title) g.querySelector("title").textContent = title;
  }
  for (const [id, g] of state.commEls) {
    if (!seen.has(id)) {
      g.remove();
      state.commEls.delete(id);
    }
  }
}

// Durations tick without waiting for the server.
setInterval(() => {
  if (!state.tree) return;
  walk(state.tree, (n) => {
    if (n.status !== "running") return;
    const el = state.cards.get(n.id);
    if (el) setText(el, ".dur", footDuration(n));
  });
}, 1000);

// ---------- drawer ----------

function findNode(id) {
  let hit = null;
  if (state.tree) walk(state.tree, (n) => n.id === id && (hit = n));
  return hit;
}

function openDrawer(id) {
  state.selected = id;
  $("#drawer").hidden = false;
  render();
}

$("#drawer-body").addEventListener("click", (e) => {
  const b = e.target.closest(".open-thread");
  if (b) navigate({ env: state.shownEnv === "local" ? "" : state.shownEnv, threadId: b.dataset.thread });
});

$("#drawer-close").onclick = () => {
  state.selected = null;
  $("#drawer").hidden = true;
  render();
};
addEventListener("keydown", (e) => e.key === "Escape" && $("#drawer-close").click());

function renderDrawer() {
  const n = findNode(state.selected);
  if (!n) return $("#drawer-close").click();
  const own = n.costUsd != null ? money(n.costUsd) : "n/a";
  const src = { transcript: "harness transcript", context: "T3 context snapshot", none: "unavailable" }[n.usageSource] ?? "";
  const origin = { project: "T3 project", root: "Thread", provider_native: "Native subagent", app_owned: "T3 delegate_task", thread: "Launched thread" }[n.origin] ?? n.origin;
  const html = `
    <h2>${esc(n.name)}</h2>
    <div class="meta">${esc(modelLabel(n.model, n.provider))} · ${esc(statusMeta[n.status]?.label ?? n.status)} · ${duration(n)}</div>
    <dl>
      <dt>Kind</dt><dd>${esc(origin)}</dd>
      <dt>Provider</dt><dd>${esc(n.provider)}${n.model ? ` / ${esc(n.model)}` : ""}</dd>
      <dt>Cost</dt><dd>${own} own${n.children.length ? ` · ${n._total.priced ? money(n._total.cost) : "n/a"} incl. children` : ""}</dd>
      <dt>Tokens</dt><dd>${n.tokens ? tokens(n.tokens) : "n/a"} <span style="color:var(--muted)">(${src})</span></dd>
      <dt>Started</dt><dd>${n.startedAt ? new Date(n.startedAt).toLocaleString() : "n/a"}</dd>
      ${state.envs.length > 1 ? `<dt>Machine</dt><dd>${esc(state.envs.find((e) => e.id === state.shownEnv)?.name ?? state.shownEnv)}</dd>` : ""}
      ${n.threadId ? `<dt>Thread</dt><dd>${esc(n.threadId)}</dd>` : ""}
    </dl>
    ${state.projectId && n.threadId ? `<button class="open-thread" data-thread="${esc(n.threadId)}">Open thread view</button>` : ""}
    ${n.tools.length ? `<h3>Tools</h3><div class="chips">${n.tools.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}
    ${n.prompt ? `<h3>Prompt</h3><pre>${esc(n.prompt)}</pre>` : ""}
    ${n.result ? `<h3>Result</h3><pre>${esc(n.result)}</pre>` : ""}`;
  const body = $("#drawer-body");
  if (body._html !== html) {
    body.innerHTML = html;
    body._html = html;
  }
}

// ---------- thread picker ----------

function renderThreads() {
  const multi = state.envs.length > 1;
  const envName = (id) => state.envs.find((e) => e.id === id)?.name ?? id;
  const threadOpt = (t) =>
    `<option value="t|${esc(t.env)}|${esc(t.threadId)}">${t.running ? "● " : ""}${esc(t.title)}${t.agents ? ` (${t.agents})` : ""}</option>`;
  let html = `<option value="">Latest active thread</option>`;

  if (state.groupBy === "project") {
    // One group per T3 project (a directory, worktrees included); its first entry opens the project view.
    const groups = new Map();
    for (const t of state.threads) {
      const key = `${t.env}|${t.projectId}`;
      if (!groups.has(key)) groups.set(key, { env: t.env, projectId: t.projectId, name: t.project, threads: [] });
      groups.get(key).threads.push(t);
    }
    for (const g of groups.values()) {
      const label = multi ? `${g.name} · ${envName(g.env)}` : g.name;
      const running = g.threads.some((t) => t.running);
      html += `<optgroup label="${esc(label)}">`;
      html += `<option value="p|${esc(g.env)}|${esc(g.projectId)}">${running ? "● " : ""}◆ All threads in ${esc(g.name)}</option>`;
      html += g.threads.map(threadOpt).join("") + `</optgroup>`;
    }
  } else if (multi) {
    // One group per machine, so threads from T3 Connect environments are easy to tell apart.
    for (const e of state.envs) {
      const list = state.threads.filter((t) => t.env === e.id);
      const label = e.error ? `${e.name} (offline)` : e.name;
      html += `<optgroup label="${esc(label)}">${list.map(threadOpt).join("") || `<option disabled>No threads</option>`}</optgroup>`;
    }
  } else html += state.threads.map(threadOpt).join("");

  for (const e of state.envs.filter((e) => e.error && state.groupBy === "project")) {
    html += `<optgroup label="${esc(e.name)} (offline)"><option disabled>Can't reach this machine</option></optgroup>`;
  }
  if (select._html !== html) {
    select.innerHTML = html;
    select._html = html;
  }
  const env = state.env || "local";
  select.value = state.projectId ? `p|${env}|${state.projectId}` : state.threadId ? `t|${env}|${state.threadId}` : "";
}

function navigate({ env = "", threadId = "", projectId = "" }) {
  stopReplay();
  Object.assign(state, { env, threadId, projectId });
  const u = new URL(location.href);
  const set = { env: env && env !== "local" ? env : "", thread: threadId, project: projectId };
  for (const [k, v] of Object.entries(set)) v ? u.searchParams.set(k, v) : u.searchParams.delete(k);
  history.replaceState(null, "", u);
  reset();
  connect();
}

select.onchange = () => {
  if (!select.value) return navigate({});
  const [kind, env, id] = select.value.split(/\|([^|]*)\|(.*)/s);
  navigate(kind === "p" ? { env, projectId: id } : { env, threadId: id });
};

const layoutEl = $("#layout");
const paintLayout = () => layoutEl.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.l === state.layout));
paintLayout();
layoutEl.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.dataset.l === state.layout) return;
  state.layout = b.dataset.l;
  localStorage.setItem("agents-layout", state.layout);
  paintLayout();
  state.refit = true; // re-zoom to fit the new shape
  render();
});

const groupEl = $("#group-by");
const paintGroup = () => groupEl.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.g === state.groupBy));
paintGroup();
groupEl.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.groupBy = b.dataset.g;
  localStorage.setItem("agents-group-by", state.groupBy);
  paintGroup();
  renderThreads();
});

function reset() {
  state.firstPaint = true;
  state.collapsed.clear();
  state.selected = null;
  $("#drawer").hidden = true;
  for (const el of state.cards.values()) el.remove();
  state.cards.clear();
  wires.innerHTML = "";
  state.wireEls.clear();
  state.dotEls.clear();
  state.commEls.clear();
}

// ---------- data ----------

let source = null;
let shownRoot = null;
function accept(snap) {
  state.threads = snap.threads ?? [];
  state.envs = snap.envs ?? [];
  state.shownEnv = snap.env ?? "local";
  renderThreads();
  // Keep the latest live snapshot aside while a replay owns the canvas.
  if (replay) {
    if (snap.tree?.id === shownRoot) replay.live = snap.tree;
    return;
  }
  if (!snap.tree && snap.error) {
    state.tree = null;
    render();
    $("#empty").textContent = `Couldn't load this thread: ${snap.error}`;
    return;
  }
  // "Latest active" can switch threads under us: start a clean canvas when it does.
  if (snap.tree && shownRoot && snap.tree.id !== shownRoot) reset();
  shownRoot = snap.tree?.id ?? null;
  state.tree = snap.tree;
  render();
  if (autoReplay && state.tree) {
    autoReplay = false;
    startReplay();
  }
}

function connect() {
  source?.close();
  const q = new URLSearchParams();
  if (state.projectId) q.set("project", state.projectId);
  else if (state.threadId) q.set("thread", state.threadId);
  if (state.env && state.env !== "local") q.set("env", state.env);
  if (params.get("token")) q.set("token", params.get("token"));
  source = new EventSource(`/api/stream?${q}`);
  source.onmessage = (e) => accept(JSON.parse(e.data));
}

// ---------- replay ----------

const SPEEDS = [2, 5, 10];
let replay = null; // { tl, source, live, speed, p, wall, t, ended }
let speed = Number(params.get("replay")) || Number(localStorage.getItem("agents-replay-speed")) || 5;
if (!SPEEDS.includes(speed)) speed = 5;
let autoReplay = params.has("replay"); // ?replay or ?replay=10 starts one as soon as data arrives
const replayBtn = $("#replay-btn");
const speedsEl = $("#speeds");
const progress = $("#replay-progress");

speedsEl.innerHTML = SPEEDS.map((x) => `<button data-speed="${x}">${x}x</button>`).join("");
const paintSpeeds = () => speedsEl.querySelectorAll("button").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === speed));
paintSpeeds();

speedsEl.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (replay) {
    // Re-anchor so changing speed mid-replay doesn't jump.
    replay.p = position();
    replay.wall = performance.now();
  }
  speed = Number(b.dataset.speed);
  localStorage.setItem("agents-replay-speed", speed);
  paintSpeeds();
  if (!replay) startReplay();
});

replayBtn.onclick = () => (replay ? stopReplay() : startReplay());
addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey && !e.target.closest?.("select, input")) replayBtn.click();
});

const position = () => (replay.ended ? replay.tl.total : Math.min(replay.tl.total, replay.p + (performance.now() - replay.wall) * speed));

const clockText = (msWall) => {
  const s = Math.max(0, Math.round(msWall / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function startReplay() {
  const source = replay?.source ?? state.tree;
  if (!source) return;
  const tl = buildTimeline(source);
  if (!tl) return;
  // ?at=0.4 starts 40% of the way in (only for the first, URL-driven replay).
  const at = Math.min(1, Math.max(0, Number(params.get("at")) || 0));
  params.delete("at");
  replay = { tl, source, live: replay?.live ?? source, p: at * tl.total, wall: performance.now(), t: tl.start, ended: false };
  // Start from an empty canvas so every card animates in, but keep the current zoom and scroll.
  const zoom = state.zoom;
  reset();
  state.firstPaint = false;
  setZoom(zoom);
  document.body.classList.add("replaying");
  replayBtn.innerHTML = `<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg><span>Stop</span><span class="when"></span>`;
  clearInterval(replayTimer);
  replayTimer = setInterval(frame, 50); // ~20 fps is plenty for cards; a timer also keeps going headless
  frame();
}

let replayTimer = null;
function frame() {
  if (!replay) return;
  const p = position();
  replay.t = timeAt(replay.tl, p);
  state.tree = treeAt(replay.source, replay.t, replay.tl.now);
  render();
  progress.style.transform = `scaleX(${replay.tl.total ? p / replay.tl.total : 1})`;
  replayBtn.querySelector(".when").textContent = `${clockText(p / speed)} / ${clockText(replay.tl.total / speed)}`;
  if (p >= replay.tl.total && !replay.ended) {
    replay.ended = true;
    setTimeout(() => replay?.ended && stopReplay(), 1500);
  }
}

function stopReplay() {
  if (!replay) return;
  const live = replay.live;
  replay = null;
  clearInterval(replayTimer);
  document.body.classList.remove("replaying");
  progress.style.transform = "scaleX(0)";
  replayBtn.innerHTML = `<svg viewBox="0 0 16 16"><path d="M5 3.5v9l7.5-4.5z"/></svg><span>Replay</span>`;
  state.tree = live;
  render();
}

// ---------- zoom (ctrl/cmd + wheel, +/-/0) ----------

state.zoom = 1;
function setZoom(z) {
  state.zoom = Math.round(Math.max(0.3, Math.min(1.6, z)) * 100) / 100;
  canvas.style.zoom = state.zoom;
}
viewport.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  },
  { passive: false },
);
addEventListener("keydown", (e) => {
  if (e.target.closest?.("select, input")) return;
  if (e.key === "=" || e.key === "+") setZoom(state.zoom * 1.1);
  else if (e.key === "-") setZoom(state.zoom / 1.1);
  else if (e.key === "0") setZoom(1);
});

// ---------- drag to pan ----------

let drag = null;
viewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".card, button, select")) return;
  drag = { x: e.clientX, y: e.clientY, l: viewport.scrollLeft, t: viewport.scrollTop };
  viewport.classList.add("dragging");
});
addEventListener("pointermove", (e) => {
  if (!drag) return;
  viewport.scrollLeft = drag.l - (e.clientX - drag.x);
  viewport.scrollTop = drag.t - (e.clientY - drag.y);
});
addEventListener("pointerup", () => {
  drag = null;
  viewport.classList.remove("dragging");
});

if (params.has("demo")) {
  select.hidden = true;
  $("#replay").hidden = true;
  startDemo((tree) => {
    if (shownRoot && tree.id !== shownRoot) reset();
    shownRoot = tree.id;
    state.tree = tree;
    render();
  });
} else connect();
