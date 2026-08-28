import { describe, expect, it } from "vite-plus/test";

import { maskDeepgramKey, normalizeDeepgramKey } from "./deepgramKeyFormat";

describe("normalizeDeepgramKey", () => {
  it("keeps a plain key as-is", () => {
    expect(normalizeDeepgramKey("abc123")).toBe("abc123");
  });

  it("strips the whitespace a paste drags along", () => {
    expect(normalizeDeepgramKey("  abc123\n")).toBe("abc123");
  });

  it("strips the quotes a password manager adds", () => {
    expect(normalizeDeepgramKey('"abc123"')).toBe("abc123");
    expect(normalizeDeepgramKey("'abc123'")).toBe("abc123");
    expect(normalizeDeepgramKey(' "abc123" ')).toBe("abc123");
  });

  it("treats an empty or whitespace-only value as no key", () => {
    expect(normalizeDeepgramKey("")).toBeUndefined();
    expect(normalizeDeepgramKey("   ")).toBeUndefined();
    expect(normalizeDeepgramKey('""')).toBeUndefined();
  });
});

describe("maskDeepgramKey", () => {
  it("shows only the ends of a real key", () => {
    const masked = maskDeepgramKey("abcd1234567890wxyz");
    expect(masked.startsWith("abcd")).toBe(true);
    expect(masked.endsWith("wxyz")).toBe(true);
    expect(masked).not.toContain("1234567890");
  });

  it("reveals nothing from a short value", () => {
    expect(maskDeepgramKey("abc")).toBe("•••");
  });
});
