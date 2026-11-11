import { describe, expect, it } from "vitest";
import { withDisplayName } from "../src/resend";

/** PC-14 — a tenant may name its sender; it may not change the sending address. */
describe("withDisplayName", () => {
  it("swaps the display name and keeps the address", () => {
    expect(withDisplayName("HireOps <no-reply@mail.example.com>", "Solenis Talent")).toBe(
      '"Solenis Talent" <no-reply@mail.example.com>',
    );
    expect(withDisplayName("no-reply@mail.example.com", "Solenis")).toBe(
      '"Solenis" <no-reply@mail.example.com>',
    );
  });
  it("strips characters that could break out of the display-name position", () => {
    expect(withDisplayName("x@y.com", 'Evil" <a@b.com>\r\nBcc: z')).toBe(
      '"Evil a@b.comBcc: z" <x@y.com>',
    );
    expect(withDisplayName("HireOps <x@y.com>", '"<>')).toBe("HireOps <x@y.com>");
  });
});
