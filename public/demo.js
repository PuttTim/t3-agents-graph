// ?demo replays the scenario from the original clip with fake data, no T3 needed.

const AGENTS = [
  { key: "orc", parent: null, name: "Orchestrator", model: "claude-opus-5-5", provider: "claudeAgent", task: "Launch the new pricing page by Friday", tools: ["mcp__slack__post", "mcp__notion__search", "mcp__github__pr"], start: 0, end: 24, rate: 0.03 },
  { key: "res", parent: "orc", name: "Researcher", model: "claude-sonnet-5-5", provider: "claudeAgent", task: "Compare the pricing of five competitors", tools: ["mcp__notion__search", "mcp__slack__read"], start: 1.2, end: 14, rate: 0.012 },
  { key: "wri", parent: "orc", name: "Writer", model: "claude-sonnet-5-5", provider: "claudeAgent", task: "Write the copy for the three plans", tools: ["mcp__notion__write", "mcp__figma__read"], start: 2.4, end: 18, rate: 0.01 },
  { key: "scr", parent: "res", name: "Scraper", model: "gemini-3.8-flash", provider: "gemini", task: "Read the pricing pages of Linear, Notion and three more", tools: ["mcp__notion__read", "WebFetch"], start: 3.4, end: 10, rate: 0.004 },
  { key: "cod", parent: "orc", name: "Coder", model: "gpt-6-sol", provider: "codex", task: "Build the page and wire up checkout", tools: ["mcp__github__push", "mcp__stripe__prices", "mcp__figma__read"], start: 4.6, end: 22, rate: 0.024 },
  { key: "ana", parent: "res", name: "Analyst", model: "claude-sonnet-5-5", provider: "claudeAgent", task: "Summarize 120 G2 reviews that mention price", tools: ["Bash", "mcp__notion__read"], start: 6, end: 12.5, rate: 0.009 },
  { key: "tst", parent: "cod", name: "Tester", model: "gpt-6-mini", provider: "codex", task: "Write and run the checkout tests", tools: ["mcp__github__checks"], start: 8, end: 13.5, rate: 0.003, stopped: true },
  { key: "ts2", parent: "cod", name: "Tester", model: "gpt-6-mini", provider: "codex", task: "Fix the coupon test and run all again", tools: ["mcp__github__checks", "mcp__stripe__test"], start: 14, end: 20.5, rate: 0.003 },
];

const LOOP = 30; // seconds

export function startDemo(onTree) {
  let epoch = Date.now();
  let loop = 0;
  const tick = () => {
    let t = (Date.now() - epoch) / 1000;
    if (t > LOOP) {
      epoch = Date.now();
      loop++;
      t = 0;
    }
    const nodes = new Map();
    for (const a of AGENTS) {
      if (t < a.start) continue;
      const finished = t >= a.end;
      const ran = Math.min(t, a.end) - a.start;
      nodes.set(a.key, {
        id: `demo${loop}:${a.key}`,
        threadId: null,
        parentId: a.parent && `demo${loop}:${a.parent}`,
        origin: a.parent ? "provider_native" : "root",
        provider: a.provider,
        name: a.name,
        model: a.model,
        task: a.task,
        prompt: a.task,
        result: finished && !a.stopped ? "Done." : null,
        status: finished ? (a.stopped ? "stopped" : "done") : "running",
        startedAt: new Date(epoch + a.start * 1000).toISOString(),
        completedAt: finished ? new Date(epoch + a.end * 1000).toISOString() : null,
        costUsd: ran * a.rate,
        tokens: Math.round(ran * a.rate * 250_000),
        usageSource: "transcript",
        tools: a.tools,
        children: [],
      });
    }
    for (const a of AGENTS) {
      const n = nodes.get(a.key);
      if (n && a.parent) nodes.get(a.parent)?.children.push(n);
    }
    const root = nodes.get("orc");
    if (root) onTree(root);
  };
  tick();
  setInterval(tick, 500);
}
