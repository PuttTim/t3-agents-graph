// Replays a thread's tree from its recorded timestamps. Idle stretches (nothing running anywhere
// in the tree, e.g. overnight between turns) are squeezed to GAP_CAP so playback stays watchable.

const GAP_CAP = 2000; // ms of thread time an idle gap is shortened to, before the speedup

const ms = (iso) => (iso ? Date.parse(iso) : null);

function intervals(node, now) {
  if (node.runs?.length) return node.runs.map((r) => [ms(r.start), ms(r.end) ?? now]);
  if (node.startedAt) return [[ms(node.startedAt), ms(node.completedAt) ?? (node.status === "running" ? now : ms(node.startedAt))]];
  return [];
}

function startOf(node) {
  if (node.runs?.length) return ms(node.runs[0].start);
  return node.startedAt ? ms(node.startedAt) : -Infinity;
}

/** Maps playback position (ms) <-> thread time (epoch ms), with idle gaps capped. */
export function buildTimeline(root, now = Date.now()) {
  const all = [];
  const walk = (n) => {
    all.push(...intervals(n, now).filter(([a, b]) => b >= a));
    n.children.forEach(walk);
  };
  walk(root);
  if (!all.length) return null;
  all.sort((x, y) => x[0] - y[0]);

  const union = [];
  for (const [a, b] of all) {
    const last = union[union.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else union.push([a, b]);
  }

  const segs = [];
  let p = 0;
  union.forEach(([a, b], i) => {
    if (i) p += Math.min(a - union[i - 1][1], GAP_CAP);
    segs.push({ t0: a, t1: b, p0: p });
    p += b - a;
  });
  return { segs, total: p, start: union[0][0], end: union[union.length - 1][1], now };
}

export function timeAt(tl, p) {
  const { segs } = tl;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const p1 = s.p0 + (s.t1 - s.t0);
    if (p <= p1) {
      if (p >= s.p0) return s.t0 + (p - s.p0);
      // Inside the squeezed gap before this segment: move through it proportionally.
      const prev = segs[i - 1];
      const gapP = s.p0 - (prev.p0 + (prev.t1 - prev.t0));
      const f = gapP ? (p - (s.p0 - gapP)) / gapP : 1;
      return prev.t1 + f * (s.t0 - prev.t1);
    }
  }
  return tl.end;
}

/** The tree as it looked at thread time `t`: unstarted agents hidden, cost and tokens grown pro rata. */
export function treeAt(node, t, now) {
  if (startOf(node) > t) return null;
  const children = node.children.map((c) => treeAt(c, t, now)).filter(Boolean);
  const out = { ...node, children };
  let frac = 1;

  if (node.runs?.length) {
    let done = 0;
    let total = 0;
    let activeMs = 0;
    let current = null;
    for (const r of node.runs) {
      const a = ms(r.start);
      const b = ms(r.end) ?? now;
      total += b - a;
      if (t >= b && r.end) {
        done += b - a;
        activeMs += b - a;
      } else if (t >= a) {
        done += Math.min(t, b) - a;
        current = r.start;
      }
    }
    frac = total ? done / total : 1;
    out.activeMs = activeMs;
    out.runStartedAt = current;
    const finished = !current && node.runs.every((r) => r.end && t >= ms(r.end));
    out.status = current ? "running" : finished ? node.status : "idle";
    out.completedAt = current ? null : node.completedAt;
  } else if (node.startedAt) {
    const a = ms(node.startedAt);
    const b = ms(node.completedAt) ?? now;
    const finished = node.completedAt && t >= b;
    frac = b > a ? Math.min(1, (Math.min(t, b) - a) / (b - a)) : 1;
    out.status = finished ? node.status : "running";
    out.completedAt = finished ? node.completedAt : null;
  }

  if (node.costUsd != null) out.costUsd = node.costUsd * frac;
  out.tokens = Math.round((node.tokens ?? 0) * frac);
  return out;
}
