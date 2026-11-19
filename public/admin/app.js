import { api, getCsrfToken, setCsrfToken, clearCsrfToken } from "./api.js";
import { resolveShellView } from "./shell-state.mjs";
import * as charts from "./charts.js";
import * as dom from "./lib/dom.js";
import * as format from "./lib/format.js";
import * as status from "./lib/status.js";
import { computeDataSafetyScore } from "./lib/score.js";
import {
  isDemo, enableDemo, disableDemo, demoScenario, setScenario, startDemoStream, DEMO_SCENARIOS,
} from "./demo.js";
import { mountOverview } from "./views/overview.js";
import { mountMonitoring } from "./views/monitoring.js";
import { mountDevices } from "./views/devices.js";
import { mountQuarantine } from "./views/quarantine.js";
import { mountConfig } from "./views/config.js";
import { mountLogs } from "./views/logs.js";
import { mountMaintenance } from "./views/maintenance.js";
import { mountConnect } from "./views/connect.js";
import { mountNetwork } from "./views/network.js";
import { mountSetup } from "./views/setup.js";

const root = document.getElementById("app");
const BASE_TITLE = "DBHub Admin";
const THEME_KEY = "dbhub_theme";

let currentRoute = location.hash || "#/overview";
let sseController = null;
let demoTimer = null;
let lastSample = null;
let history = {};
let connectionState = "offline";
let lastUpdate = null;
let currentUpdate = null;
let errorBanner = null;
let demoBanner = null;

/* --------------------------------- theme ---------------------------------- */
function currentTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "dark";
  } catch (e) {
    return "dark";
  }
}

function applyTheme(theme, persist = true) {
  document.documentElement.setAttribute("data-theme", theme);
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
  }
  window.dispatchEvent(new Event("dbhub:themechange"));
}

function themeToggle() {
  const wrap = dom.el("div", { class: "theme-toggle", role: "group", "aria-label": "Colour theme" });
  const active = currentTheme();
  for (const theme of ["dark", "light", "system"]) {
    const btn = dom.el("button", { type: "button", text: theme[0].toUpperCase() + theme.slice(1), title: `${theme} theme` });
    if (theme === active) btn.classList.add("active");
    btn.addEventListener("click", () => {
      applyTheme(theme);
      for (const b of wrap.querySelectorAll("button")) b.classList.remove("active");
      btn.classList.add("active");
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

function updateTitle() {
  document.title = isDemo() ? `[DEMO] ${BASE_TITLE}` : BASE_TITLE;
}

/* -------------------------------- errors ---------------------------------- */
function showError(msg) {
  if (!errorBanner) {
    errorBanner = dom.el("div", { class: "error-banner", role: "alert" });
    document.body.prepend(errorBanner);
  }
  errorBanner.textContent = String(msg);
  errorBanner.hidden = false;
}

function clearError() {
  if (errorBanner) errorBanner.hidden = true;
}

/* ------------------------------- demo banner ------------------------------- */
function ensureDemoBanner() {
  if (!isDemo()) {
    if (demoBanner) demoBanner.hidden = true;
    return;
  }
  if (!demoBanner) {
    demoBanner = dom.el("div", { class: "demo-banner", role: "status" });
    document.body.prepend(demoBanner);
  }
  demoBanner.textContent = "DEMO DATA — simulated, not this hub";
  demoBanner.hidden = false;
}

/* --------------------------------- header --------------------------------- */
function header() {
  const h = dom.el("header", { class: "topbar" });
  h.appendChild(dom.el("div", { class: "title", text: BASE_TITLE }));

  const conn = dom.el("span", { id: "conn", class: "badge", text: isDemo() ? "demo" : connectionState });
  conn.setAttribute("aria-live", "polite");
  h.appendChild(conn);
  const updated = dom.el("span", { id: "updated", class: "muted", text: lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "" });
  h.appendChild(updated);

  h.appendChild(dom.el("div", { class: "spacer" }));
  h.appendChild(themeToggle());

  if (isDemo()) {
    const controls = dom.el("div", { class: "demo-controls" });
    const select = dom.el("select", { "aria-label": "Demo scenario", title: "Demo scenario" });
    for (const s of DEMO_SCENARIOS) {
      const opt = dom.el("option", { value: s, text: s[0].toUpperCase() + s.slice(1) });
      if (s === demoScenario()) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      const snapshot = setScenario(select.value);
      handleDemoSnapshot(snapshot);
    });
    controls.appendChild(select);
    controls.appendChild(dom.actionButton("Exit demo", () => {
      disableDemo();
      clearCsrfToken();
      location.reload();
    }));
    h.appendChild(controls);
  } else {
    h.appendChild(dom.actionButton("View demo", () => {
      enableDemo();
      location.reload();
    }));
  }

  const logoutBtn = dom.actionButton("Logout", async () => {
    try { await api("/api/v1/admin/session", { method: "DELETE" }); } catch (e) { /* ignore */ }
    clearCsrfToken();
    location.reload();
  });
  h.appendChild(logoutBtn);
  return h;
}

function nav() {
  const n = dom.el("nav", { class: "nav", "aria-label": "Primary" });
  const routes = ["overview", "monitoring", "devices", "quarantine", "config", "logs", "maintenance", "connect", "network"];
  routes.forEach((r) => {
    const a = dom.el("a", { href: "#/" + r, text: r[0].toUpperCase() + r.slice(1) });
    if (currentRoute === "#/" + r) a.classList.add("active");
    n.appendChild(a);
  });
  return n;
}

function loginDialog() {
  const wrap = dom.el("div", { class: "login" });
  const cardEl = dom.el("div", { class: "card login-card" });
  cardEl.appendChild(dom.el("h2", { text: "Admin login" }));
  const input = dom.el("input", { type: "password", placeholder: "Admin password", "aria-label": "Admin password" });
  const btn = dom.actionButton("Login", async () => {
    const password = input.value.trim();
    if (!password) return;
    try {
      const data = await api("/api/v1/admin/session", { method: "POST", body: JSON.stringify({ password }) });
      if (data && data.csrfToken) setCsrfToken(data.csrfToken);
      clearError();
      location.hash = "#/overview";
      boot();
    } catch (e) {
      const text = String((e && (e.message || e.error)) || "");
      msg.textContent = /setup/i.test(text)
        ? "Setup is not finished yet. Use the setup code link below."
        : "Invalid password";
    }
  }, { primary: true });
  const msg = dom.el("div", { class: "muted" });
  const link = dom.el("a", { href: "#/setup", text: "Use setup code" });
  const demoLink = dom.el("a", { href: "?demo=1", text: "View demo →", class: "btn btn-ghost" });
  const demoRow = dom.el("div", { class: "row" }, [dom.el("span", { class: "muted", text: "Explore the full dashboard with simulated data:" }), demoLink]);
  cardEl.append(input, btn, msg, link, demoRow);
  wrap.appendChild(cardEl);
  return wrap;
}

async function validateSession() {
  if (isDemo()) {
    setCsrfToken("demo-csrf-token");
    return true;
  }
  try {
    const s = await api("/api/v1/admin/session");
    if (s && s.authenticated) {
      if (s.csrfToken) setCsrfToken(s.csrfToken);
      return true;
    }
    return false;
  } catch (e) {
    clearCsrfToken();
    return false;
  }
}

/* --------------------------------- stream --------------------------------- */
function connectSse() {
  if (isDemo()) return;
  if (sseController) { try { sseController.abort(); } catch (e) { /* ignore */ } }
  const controller = new AbortController();
  sseController = controller;
  (async () => {
    let failures = 0;
    let backoff = 1000;
    while (!controller.signal.aborted) {
      try {
        const res = await fetch("/api/v1/admin/stream", { credentials: "same-origin", signal: controller.signal });
        if (!res.ok) throw new Error("stream " + res.status);
        connectionState = "live";
        failures = 0;
        backoff = 1000;
        updateHeader();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            handleFrame(frame);
          }
        }
        throw new Error("stream ended");
      } catch (e) {
        if (controller.signal.aborted) break;
        failures++;
        if (failures >= 3) {
          connectionState = "polling";
          startPolling();
        } else {
          connectionState = "offline";
        }
        updateHeader();
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(30000, backoff * 2);
      }
    }
  })();
}

function handleFrame(frame) {
  const lines = frame.split(/\r?\n/);
  let event = "message";
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  const dataStr = dataLines.join("\n");
  let data = null;
  try { data = dataStr ? JSON.parse(dataStr) : null; } catch (e) { data = dataStr; }
  if (event === "init") {
    lastSample = data.snapshot;
    history = data.history || history;
    lastUpdate = data.snapshot?.sampledAt;
  } else if (event === "sample") {
    lastSample = data;
    lastUpdate = data?.sampledAt;
    if (history && data?.history) Object.assign(history, data.history);
  }
  updateHeader();
  if (currentUpdate) currentUpdate(lastSample);
}

function handleDemoSnapshot(snapshot) {
  lastSample = snapshot;
  lastUpdate = snapshot.sampledAt;
  if (snapshot.history) Object.assign(history, snapshot.history);
  connectionState = "demo";
  updateHeader();
  if (currentUpdate) currentUpdate(lastSample);
}

function startDemo() {
  if (demoTimer) demoTimer();
  demoTimer = startDemoStream(handleDemoSnapshot);
}

let pollingTimer = null;
function startPolling() {
  if (isDemo() || pollingTimer) return;
  pollingTimer = setInterval(async () => {
    try {
      const snap = await api("/api/v1/admin/overview");
      lastSample = snap;
      lastUpdate = snap.sampledAt;
      // Polling has no SSE init frame, so seed/update history from the overview payload.
      if (snap && snap.history) Object.assign(history, snap.history);
      updateHeader();
      if (currentUpdate) currentUpdate(lastSample);
    } catch (e) { showError(e.message); }
  }, 5000);
}

function updateHeader() {
  const conn = document.getElementById("conn");
  if (conn) conn.textContent = isDemo() ? "demo" : connectionState;
  const upd = document.getElementById("updated");
  if (upd) upd.textContent = lastUpdate ? new Date(lastUpdate).toLocaleTimeString() : "";
}

/* --------------------------------- routes --------------------------------- */
function mountRoute(route) {
  charts.disposeAll();
  const main = document.querySelector("main") || document.createElement("main");
  if (!document.querySelector("main")) root.appendChild(main);
  while (main.firstChild) main.removeChild(main.firstChild);
  currentUpdate = null;
  const ctx = {
    api, lastSample, history, showError, clearError, setCsrfToken, boot,
    charts, dom, format, status, score: computeDataSafetyScore, toast: dom.toast,
    isDemo: isDemo(), scenario: demoScenario(),
  };
  if (route === "setup") currentUpdate = mountView("setup", main, ctx);
  else if (route === "connect") currentUpdate = mountView("connect", main, ctx);
  else if (route === "network") currentUpdate = mountView("network", main, ctx);
  else if (route === "overview") currentUpdate = mountView("overview", main, ctx);
  else if (route === "monitoring") currentUpdate = mountView("monitoring", main, ctx);
  else if (route === "devices") currentUpdate = mountView("devices", main, ctx);
  else if (route === "quarantine") currentUpdate = mountView("quarantine", main, ctx);
  else if (route === "config") currentUpdate = mountView("config", main, ctx);
  else if (route === "logs") currentUpdate = mountView("logs", main, ctx);
  else if (route === "maintenance") currentUpdate = mountView("maintenance", main, ctx);
  if (currentUpdate && lastSample) currentUpdate(lastSample);
}

const VIEW_MOUNT = {
  overview: mountOverview, monitoring: mountMonitoring, devices: mountDevices,
  quarantine: mountQuarantine, config: mountConfig, logs: mountLogs,
  maintenance: mountMaintenance, connect: mountConnect, network: mountNetwork,
  setup: mountSetup,
};
function mountView(name, main, ctx) {
  const fn = VIEW_MOUNT[name];
  return fn ? fn(main, ctx) : null;
}

function renderShell() {
  charts.disposeAll();
  while (root.firstChild) root.removeChild(root.firstChild);
  updateTitle();
  ensureDemoBanner();
  const hasCsrf = isDemo() || Boolean(getCsrfToken());
  let view = resolveShellView(currentRoute, hasCsrf);
  if (view === "login") {
    root.appendChild(loginDialog());
    return;
  }
  if (view === "setup") {
    const main = document.createElement("main");
    root.appendChild(main);
    mountRoute("setup");
    return;
  }
  const known = ["overview", "monitoring", "devices", "quarantine", "config", "logs", "maintenance", "connect", "network"];
  if (!known.includes(view)) view = "overview";
  root.appendChild(header());
  root.appendChild(nav());
  const main = document.createElement("main");
  root.appendChild(main);
  mountRoute(view);
}

window.addEventListener("hashchange", () => {
  currentRoute = location.hash || "#/overview";
  renderShell();
});

window.addEventListener("dbhub:unauthorized", () => {
  clearCsrfToken();
  renderShell();
});

async function boot() {
  applyTheme(currentTheme(), false);
  updateTitle();
  ensureDemoBanner();

  if (isDemo()) {
    setCsrfToken("demo-csrf-token");
    connectionState = "demo";
    currentRoute = location.hash || "#/overview";
    if (currentRoute === "#/setup") currentRoute = "#/overview";
    startDemo();
    renderShell();
    return;
  }

  let setupRequired = false;
  try {
    const s = await api("/api/v1/admin/session");
    if (s && s.setupRequired) setupRequired = true;
    if (s && s.authenticated && s.csrfToken) setCsrfToken(s.csrfToken);
  } catch (e) { /* ignore */ }
  if (setupRequired) {
    location.hash = "#/setup";
    currentRoute = "#/setup";
    renderShell();
    return;
  }
  if (!(await validateSession())) {
    renderShell();
    return;
  }
  currentRoute = location.hash || "#/overview";
  if (currentRoute === "#/setup") currentRoute = "#/overview";
  connectSse();
  renderShell();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) updateHeader();
});

boot();
