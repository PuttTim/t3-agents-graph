// Export the canvas as PNG / SVG (a snapshot of the live DOM inside an SVG <foreignObject>,
// with the page stylesheet inlined) or the tree as JSON.

const TITLE_H = 64;

const slug = (s) =>
  (s || "agents")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

export const fileName = (title, ext) => `agents-${slug(title)}-${stamp()}.${ext}`;

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let cssCache = null;
async function stylesheet() {
  if (cssCache === null) {
    const response = await fetch(new URL("./styles.css", import.meta.url));
    if (!response.ok) throw new Error("Couldn't load export styles");
    cssCache = await response.text();
  }
  return cssCache;
}

const esc = (s = "") => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Standalone SVG of the canvas at 100% zoom, in the current theme, with a title line on top. */
export async function canvasSvg(canvas, { title, subtitle }) {
  const width = parseFloat(canvas.style.width) || canvas.scrollWidth;
  const height = (parseFloat(canvas.style.height) || canvas.scrollHeight) + TITLE_H;
  const theme = document.documentElement.dataset.theme ?? "light";

  const clone = canvas.cloneNode(true);
  clone.removeAttribute("id");
  clone.style.zoom = "1";
  clone.style.margin = "0";
  clone.style.position = "absolute";
  clone.style.top = `${TITLE_H}px`;
  clone.style.left = "0";
  // Freeze anything mid-animation in its final state, and drop UI-only state.
  clone.querySelectorAll(".enter").forEach((el) => el.classList.remove("enter"));
  clone.querySelectorAll(".selected").forEach((el) => el.classList.remove("selected"));
  clone.querySelectorAll("button.kids").forEach((el) => el.replaceWith(Object.assign(document.createElement("span"), { className: "kids", innerHTML: el.innerHTML })));

  const body = new XMLSerializer().serializeToString(clone);
  const css = `${await stylesheet()}
    .export-root * { animation: none !important; transition: none !important; }`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" data-theme="${theme}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style><![CDATA[${css}]]></style>
<foreignObject x="0" y="0" width="${width}" height="${height}">
<div xmlns="http://www.w3.org/1999/xhtml" class="export-root" style="width:${width}px;height:${height}px">
<div class="export-title"><b>${esc(title)}</b><span>${esc(subtitle)}</span></div>
${body}
</div>
</foreignObject>
</svg>`;
  return { svg, width, height };
}

/** PNG at `scale`x. Chromium (incl. T3's desktop app) allows this; Safari blocks foreignObject on canvas. */
export async function canvasPng(canvas, meta, scale = 2) {
  const { svg, width, height } = await canvasSvg(canvas, meta);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  // Stay under typical browser canvas limits for huge trees.
  const s = Math.min(scale, Math.sqrt(16_000_000 / (width * height)), 16_000 / Math.max(width, height));
  const out = document.createElement("canvas");
  out.width = Math.round(width * s);
  out.height = Math.round(height * s);
  const ctx = out.getContext("2d");
  ctx.scale(s, s);
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"));
}

/** The tree as data: everything the cards show, minus render-only fields. */
export function treeJson(tree, extra) {
  const clean = (n) => {
    const { _total, children, ...rest } = n;
    return { ...rest, totalCostUsd: _total?.priced ? _total.cost : null, children: children.map(clean) };
  };
  return new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...extra, tree: clean(tree) }, null, 2)], {
    type: "application/json",
  });
}
