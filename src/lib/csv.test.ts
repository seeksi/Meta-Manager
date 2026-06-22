import { describe, it, expect } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("joins headers and rows with CRLF", () => {
    expect(toCsv(["a", "b"], [[1, 2], [3, 4]])).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("quotes fields with commas, quotes, or newlines and doubles inner quotes", () => {
    expect(toCsv(["x"], [['a,b'], ['he said "hi"'], ["line\nbreak"]]))
      .toBe('x\r\n"a,b"\r\n"he said ""hi"""\r\n"line\nbreak"');
  });

  it("renders null/undefined as empty", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("a,b\r\n,");
  });
});
