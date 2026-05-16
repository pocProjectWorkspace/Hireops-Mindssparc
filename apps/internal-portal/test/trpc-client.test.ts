import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { TRPCClientError } from "@trpc/client";
import { handleTRPCError } from "../src/lib/trpc-client";

/**
 * The error handler's job is to map TRPC error codes → toast text +
 * side effect. We exercise the mapping by passing a custom onMessage
 * sink and asserting the right strings come through.
 */

function makeTRPCError(code: string, zodError: unknown = null): TRPCClientError<never> {
  return Object.assign(new TRPCClientError("boom"), {
    data: { code, zodError },
  }) as TRPCClientError<never>;
}

describe("handleTRPCError", () => {
  it("FORBIDDEN → permission message", () => {
    let captured = "";
    handleTRPCError(makeTRPCError("FORBIDDEN"), { onMessage: (m) => (captured = m) });
    assert.match(captured, /permission/i);
  });

  it("NOT_FOUND → record-not-found message", () => {
    let captured = "";
    handleTRPCError(makeTRPCError("NOT_FOUND"), { onMessage: (m) => (captured = m) });
    assert.match(captured, /not found/i);
  });

  it("BAD_REQUEST with zodError → silent (caller renders field errors)", () => {
    let captured = "";
    handleTRPCError(makeTRPCError("BAD_REQUEST", { formErrors: [], fieldErrors: {} }), {
      onMessage: (m) => (captured = m),
    });
    assert.equal(captured, "");
  });

  it("non-tRPC error → generic fallback", () => {
    let captured = "";
    handleTRPCError(new Error("network down"), { onMessage: (m) => (captured = m) });
    assert.match(captured, /something went wrong/i);
  });
});
