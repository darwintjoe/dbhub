import { isDemo } from "./demo.js";
import { demoApi } from "./demo-api.js";

const CSRF_KEY = "dbhub_csrf_token";

export function getCsrfToken() {
  return sessionStorage.getItem(CSRF_KEY);
}

export function setCsrfToken(token) {
  if (token) sessionStorage.setItem(CSRF_KEY, token);
}

export function clearCsrfToken() {
  sessionStorage.removeItem(CSRF_KEY);
}

export async function api(path, options = {}) {
  // Demo mode never touches the network.
  if (isDemo()) return demoApi(path, options);
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  const csrf = getCsrfToken();
  if (csrf && options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrf;
  const res = await fetch(path, Object.assign({}, options, { headers, credentials: "same-origin" }));
  if (res.status === 401) {
    clearCsrfToken();
    window.dispatchEvent(new CustomEvent("dbhub:unauthorized"));
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const data = await res.json();
    if (data && data.csrfToken) setCsrfToken(data.csrfToken);
    return data;
  }
  return res.text();
}

export function logout() {
  if (isDemo()) {
    clearCsrfToken();
    location.reload();
    return;
  }
  fetch("/api/v1/admin/session", { method: "DELETE", credentials: "same-origin" }).finally(() => {
    clearCsrfToken();
    location.reload();
  });
}