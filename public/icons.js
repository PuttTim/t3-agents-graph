// Provider tiles, status glyphs and tool badges.

const claude = `<svg viewBox="0 0 24 24"><g fill="#d97757">${Array.from({ length: 12 }, (_, i) => {
  const len = i % 2 ? 8.2 : 10;
  return `<rect x="11.1" y="${12 - len}" width="1.8" height="${len}" rx=".9" transform="rotate(${i * 30} 12 12)"/>`;
}).join("")}</g></svg>`;

const openai = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><g transform="translate(12 12)">${[0, 60, 120, 180, 240, 300]
  .map((a) => `<path d="M0-8.5c2.6 0 4.6 2 4.6 4.6v5" transform="rotate(${a})"/>`)
  .join("")}</g></svg>`;

const gemini = `<svg viewBox="0 0 24 24"><defs><linearGradient id="gm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8bff"/><stop offset="1" stop-color="#2557d6"/></linearGradient></defs><path fill="url(#gm)" d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z"/></svg>`;

const opencode = `<svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="16" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="8.5" y="9" width="7" height="7.5" fill="currentColor" opacity=".45"/></svg>`;

const cursor = `<svg viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 7l9 5 9-5M12 12v10" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".6"/></svg>`;

const generic = `<svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 20c1.2-3.6 3.8-5.4 7-5.4s5.8 1.8 7 5.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;

const folder = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 014.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0121 8.7v9.8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z"/></svg>`;

export function providerIcon(provider = "", model = "") {
  if (provider === "project") return folder;
  const p = `${provider} ${model}`.toLowerCase();
  if (p.includes("gemini")) return gemini;
  if (p.includes("claude") || p.includes("opus") || p.includes("sonnet") || p.includes("haiku") || p.includes("fable")) return claude;
  if (p.includes("codex") || p.includes("gpt") || p.includes("openai") || /\bo\d/.test(p)) return openai;
  if (p.includes("opencode")) return opencode;
  if (p.includes("cursor")) return cursor;
  return generic;
}

export const statusMeta = {
  running: { label: "Running", icon: `<svg class="spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 2a6 6 0 1 0 6 6" /></svg>` },
  waiting: { label: "Needs input", icon: `<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="4" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12" cy="8" r="1.4"/></svg>` },
  done: { label: "Done", icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7" /></svg>` },
  idle: { label: "Idle", icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5.5 4.5v7M10.5 4.5v7" /></svg>` },
  stopped: { label: "Stopped", icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>` },
  failed: { label: "Failed", icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 5l6 6M11 5l-6 6" /></svg>` },
};

// ---------- tools ----------

const glyph = (path, color) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const builtins = [
  { test: /^(bash|exec|exec_command|shell|local_shell|command)/i, label: "Terminal", svg: glyph(`<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6l2 2-2 2M8.5 10.5h3"/>`, "currentColor") },
  { test: /^(webfetch|websearch|web_search|fetch|browser)/i, label: "Web", svg: glyph(`<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>`, "currentColor") },
  { test: /^(edit|write|multiedit|notebookedit|apply_patch|file_change)/i, label: "Edit files", svg: glyph(`<path d="M10.5 2.5l3 3L6 13H3v-3z"/>`, "currentColor") },
  { test: /^(read|glob|grep|ls|view_image|list_dir)/i, label: "Read files", svg: glyph(`<path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9 1.5V5h4"/>`, "currentColor") },
  { test: /^(agent|task|spawn_agent|send_message|wait_agent)$/i, label: "Subagents", svg: glyph(`<circle cx="8" cy="3.5" r="2"/><circle cx="3.5" cy="12.5" r="2"/><circle cx="12.5" cy="12.5" r="2"/><path d="M8 5.5v2.5M8 8l-4 2.5M8 8l4 2.5"/>`, "currentColor") },
];

const brands = {
  slack: { c: "#4a154b", l: "S" },
  notion: { c: "#111", l: "N" },
  github: { c: "#24292f", l: "GH" },
  figma: { c: "#f24e1e", l: "F" },
  stripe: { c: "#635bff", l: "S" },
  linear: { c: "#5e6ad2", l: "L" },
  google_drive: { c: "#1a73e8", l: "G" },
  gmail: { c: "#ea4335", l: "M" },
  canva: { c: "#00c4cc", l: "C" },
  telegram: { c: "#2aabee", l: "T" },
  "t3-code": { c: "#7c3aed", l: "T3" },
  t3_code: { c: "#7c3aed", l: "T3" },
};

const hue = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);

function mcpServer(name) {
  const m = name.match(/^mcp__(.+?)__/);
  if (!m) return null;
  return m[1].replace(/^claude_ai_/, "").replace(/^plugin_[^_]+_/, "");
}

/** Dedupes raw tool names into at most `max` badges: MCP servers first (like integrations), then built-ins. */
export function toolBadges(tools = [], max = 4) {
  const seen = new Map();
  for (const t of tools) {
    if (/^(ToolSearch|TodoWrite|AskUserQuestion|Skill|update_plan|request_user_input)$/i.test(t)) continue;
    const server = mcpServer(t);
    if (server) {
      const key = `mcp:${server.toLowerCase()}`;
      if (seen.has(key)) continue;
      const b = brands[server.toLowerCase()];
      const pretty = server.replace(/[_-]+/g, " ");
      const label = b?.l ?? pretty[0].toUpperCase();
      const color = b?.c ?? `hsl(${hue(server)} 55% 45%)`;
      seen.set(key, { order: 0, title: pretty, html: `<span class="t" style="background:${color}">${label}</span>` });
      continue;
    }
    const bi = builtins.find((b) => b.test.test(t));
    if (!bi) continue;
    const key = `bi:${bi.label}`;
    if (!seen.has(key)) seen.set(key, { order: 1, title: bi.label, html: `<span class="t" style="color:var(--muted)">${bi.svg}</span>` });
  }
  return [...seen.values()]
    .sort((a, b) => a.order - b.order)
    .slice(0, max)
    .map((b) => b.html.replace('class="t"', `class="t" title="${b.title}"`))
    .join("");
}

export const chevron = `<svg viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
