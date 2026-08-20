import { describe, expect, it } from "vitest";
import { extractCodes, extractLinks } from "../src/content";

describe("extractLinks", () => {
  it("extracts and de-duplicates safe HTTP links", () => {
    expect(
      extractLinks(
        "Open https://example.com/verify?t=abc.",
        '<a href="https://example.com/verify?t=abc&amp;n=1">verify</a>',
      ),
    ).toEqual(["https://example.com/verify?t=abc", "https://example.com/verify?t=abc&n=1"]);
  });

  it("does not return non-HTTP link targets", () => {
    expect(extractLinks(undefined, '<a href="javascript:alert(1)">open</a>')).toEqual([]);
  });
});

describe("extractCodes", () => {
  it("extracts unique 4-8 digit codes from text and HTML", () => {
    expect(extractCodes("Your code is 123456", "<strong>123456</strong> Backup: 9876")).toEqual([
      "123456",
      "9876",
    ]);
  });

  it("ignores phone-like long numbers and short values", () => {
    expect(extractCodes("Call 441234567890 or use 123")).toEqual([]);
  });
});
