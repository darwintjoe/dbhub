export function resolveShellView(route, hasCsrf) {
  if (route === "#/setup" && !hasCsrf) return "setup";
  if (!hasCsrf) return "login";
  if (route === "#/setup") return "overview";
  return route.startsWith("#/") ? route.slice(2) : "overview";
}