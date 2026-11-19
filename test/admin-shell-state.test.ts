import { describe, expect, it } from "vitest";
import { resolveShellView } from "../public/admin/shell-state.mjs";

describe("admin shell state", () => {
  it("setup route without csrf mounts setup", () => {
    expect(resolveShellView("#/setup", false)).toBe("setup");
  });
  it("setup route with csrf goes to overview", () => {
    expect(resolveShellView("#/setup", true)).toBe("overview");
  });
  it("overview without csrf shows login", () => {
    expect(resolveShellView("#/overview", false)).toBe("login");
  });
  it("overview with csrf stays overview", () => {
    expect(resolveShellView("#/overview", true)).toBe("overview");
  });
  it("connect route with csrf stays connect", () => {
    expect(resolveShellView("#/connect", true)).toBe("connect");
  });
  it("empty route falls back to overview", () => {
    expect(resolveShellView("", true)).toBe("overview");
  });
});