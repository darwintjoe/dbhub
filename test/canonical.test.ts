import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/domain/canonical";

describe("canonicalJson", () => {
  it("sorts keys independently of input order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested object keys", () => {
    expect(canonicalJson({ z: { d: 4, c: 3 }, a: 1 })).toBe('{"a":1,"z":{"c":3,"d":4}}');
  });

  it("preserves array order", () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("handles unicode without escaping", () => {
    expect(canonicalJson({ k: "café ☕" })).toBe('{"k":"café ☕"}');
  });
});
