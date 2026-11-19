import { el, card, actionButton, toast } from "../lib/dom.js";
import { pageTitle, kv } from "./common.js";

export function mountConfig(main, ctx) {
  const { api } = ctx;

  main.appendChild(pageTitle("Configuration", "Hot-applied settings and restart requirements"));

  const metaCard = card({ title: "Config file", subtitle: "Read-only metadata" });
  const metaBody = el("div", { class: "stack" });
  metaCard.querySelector(".card-body").appendChild(metaBody);
  main.appendChild(metaCard);

  const formCard = card({ title: "Settings", subtitle: "Values are stored in config.json" });
  const form = el("form", { class: "stack" });
  formCard.querySelector(".card-body").appendChild(form);
  main.appendChild(formCard);

  const status = el("div", { class: "muted", "aria-live": "polite" });
  const saveBtn = actionButton("Save", async () => {
    try {
      const body = collect();
      const res = await api("/api/v1/admin/config", { method: "PUT", body: JSON.stringify({ config: body, baseHash }) });
      const hot = (res.hotApplied || []).join(", ") || "none";
      const restart = (res.restartRequired || []).join(", ") || "none";
      status.textContent = `Saved. Hot-applied: ${hot}. Restart required: ${restart}.`;
      if ((res.restartRequired || []).length) status.textContent += " Restart the service manually.";
      baseHash = res.hash;
      toast("Configuration saved", "ok");
      await load();
    } catch (e) {
      if (String(e.message).includes("changed on disk")) {
        if (confirm("Config changed on disk. Reload?")) await load();
      } else ctx.showError(e.message);
    }
  }, { primary: true });
  const rotateBtn = actionButton("Rotate admin token", async () => {
    if (!confirm("Rotate admin token? The current token stops working immediately.")) return;
    try {
      const res = await api("/api/v1/admin/config/rotate-token", { method: "POST" });
      if (res && res.tokenShown === false) toast("Demo: token not shown", "info");
      else if (res && res.token) toast("Token rotated — copy it from the secure response", "ok");
      else toast("Token rotated", "ok");
    } catch (e) { ctx.showError(e.message); }
  }, { danger: true });
  main.append(el("div", { class: "row" }, [saveBtn, rotateBtn, status]));

  let baseHash = null;
  let current = {};

  function field(name, value) {
    const input = el("input", { type: "text", name });
    input.value = value === null || value === undefined ? "" : (typeof value === "object" ? JSON.stringify(value) : String(value));
    return el("div", { class: "field" }, [el("label", { text: name }), input]);
  }

  async function load() {
    while (form.firstChild) form.removeChild(form.firstChild);
    const data = await api("/api/v1/admin/config");
    baseHash = data.hash;
    current = data.config || {};
    metaBody.replaceChildren(
      kv("Path", data.path),
      kv("Hash", data.hash),
    );
    for (const k of ["companyId", "replicaId", "port", "host", "publicUrl", "dataDir", "logDir"]) {
      form.appendChild(field(k, current[k]));
    }
    for (const [group, label] of [
      ["limits", "Limits"], ["monitoring", "Monitoring"], ["backup", "Backup"],
      ["security", "Security"], ["quarantine", "Quarantine"], ["storage", "Storage"],
    ]) {
      const values = current[group] || {};
      const keys = Object.keys(values);
      if (!keys.length) continue;
      form.appendChild(el("h3", { text: label }));
      for (const k of keys) form.appendChild(field(`${group}.${k}`, values[k]));
    }
  }

  function collect() {
    const out = JSON.parse(JSON.stringify(current || {}));
    form.querySelectorAll("input").forEach((input) => {
      const parts = input.name.split(".");
      let obj = out;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      const key = parts[parts.length - 1];
      const v = input.value;
      if (v === "true") obj[key] = true;
      else if (v === "false") obj[key] = false;
      else if (/^-?\d+$/.test(v)) obj[key] = Number(v);
      else {
        try { obj[key] = JSON.parse(v); } catch (e) { obj[key] = v; }
      }
    });
    return out;
  }

  form.addEventListener("submit", (e) => e.preventDefault());
  load().catch((e) => ctx.showError(e.message));
  return () => {};
}
