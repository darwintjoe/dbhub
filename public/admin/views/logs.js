import { el, card, actionButton, badge } from "../lib/dom.js";
import { pageTitle } from "./common.js";

export function mountLogs(main, ctx) {
  const { api } = ctx;

  main.appendChild(pageTitle("Logs", "Structured log viewer with filters and download"));

  const controls = el("div", { class: "row" });
  const fileSel = el("select", { "aria-label": "Log file" });
  const linesInput = el("input", { type: "number", value: "200", min: "1", max: "2000", "aria-label": "Number of lines" });
  const levelSel = el("select", { "aria-label": "Log level" });
  for (const l of ["", "info", "warn", "error"]) {
    levelSel.appendChild(el("option", { value: l, text: l || "all levels" }));
  }
  const search = el("input", { type: "search", placeholder: "Search text", "aria-label": "Search logs" });
  const refresh = actionButton("Refresh", () => load(), { primary: true });
  const download = el("a", { class: "btn btn-ghost", text: "Download", href: "#" });
  controls.append(fileSel, linesInput, levelSel, search, refresh, download);
  main.appendChild(controls);

  const logCard = card({ title: "Output", subtitle: "Newest entries last" });
  const pre = el("pre", { text: "Loading…" });
  logCard.querySelector(".card-body").appendChild(pre);
  main.appendChild(logCard);

  async function loadFiles() {
    const data = await api("/api/v1/admin/logs?lines=1");
    while (fileSel.firstChild) fileSel.removeChild(fileSel.firstChild);
    (Array.isArray(data.files) ? data.files : []).forEach((f) => {
      fileSel.appendChild(el("option", { value: f.name, text: f.name }));
    });
    if (data.file) fileSel.value = data.file;
  }

  async function load() {
    try {
      const params = new URLSearchParams({ lines: String(Math.max(1, Number(linesInput.value) || 200)) });
      if (fileSel.value) params.set("file", fileSel.value);
      if (levelSel.value) params.set("level", levelSel.value);
      if (search.value) params.set("q", search.value);
      const data = await api("/api/v1/admin/logs?" + params.toString());
      const lines = Array.isArray(data.lines) ? data.lines : [];
      pre.textContent = lines.length ? lines.join("\n") : "No matching log lines.";
      download.href = `/api/v1/admin/logs/download?file=${encodeURIComponent(fileSel.value)}`;
    } catch (e) { ctx.showError(e.message); }
  }

  fileSel.addEventListener("change", load);
  levelSel.addEventListener("change", load);
  loadFiles().then(load).catch((e) => ctx.showError(e.message));
  return () => {};
}
