import { afterEach, describe, expect, it, vi } from "vitest";
import { ResendEmailProvider } from "../src/resend";
import type { EmailMessage } from "../src/types";

const FROM = "HireOps <no-reply@notifications.example.com>";

const MSG: EmailMessage = {
  to: "candidate@example.com",
  subject: "Your application update",
  html: "<p>Hi Anika</p>",
  text: "Hi Anika",
  templateKey: "candidate.agent_message",
  tenantId: "tenant-1",
  outboxId: "outbox-1",
};

function makeProvider() {
  return new ResendEmailProvider({ apiKey: "re_test_key", from: FROM });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ResendEmailProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("constructor rejects an empty apiKey", () => {
    expect(() => new ResendEmailProvider({ apiKey: "", from: FROM })).toThrow(
      /RESEND_API_KEY/,
    );
    expect(() => new ResendEmailProvider({ apiKey: "   ", from: FROM })).toThrow(
      /RESEND_API_KEY/,
    );
  });

  it("constructor rejects an empty from address", () => {
    expect(
      () => new ResendEmailProvider({ apiKey: "re_x", from: "" }),
    ).toThrow(/EMAIL_FROM/);
  });

  it("success: posts the correct request shape and returns providerMessageId", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "re_123" }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeProvider().send(MSG);

    expect(result.providerMessageId).toBe("re_123");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      from: FROM,
      to: "candidate@example.com",
      subject: "Your application update",
      html: "<p>Hi Anika</p>",
      text: "Hi Anika",
    });

    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("non-2xx: throws carrying the status and response body", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("domain is not verified", {
          status: 422,
          statusText: "Unprocessable Entity",
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeProvider().send(MSG)).rejects.toThrow(/422/);
    await expect(makeProvider().send(MSG)).rejects.toThrow(
      /domain is not verified/,
    );
  });

  it("non-2xx: truncates an oversized body to ~500 chars", async () => {
    const huge = "x".repeat(2000);
    const fetchMock = vi.fn(
      async () => new Response(huge, { status: 500, statusText: "Server Error" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeProvider().send(MSG)).rejects.toThrow(/\[truncated\]/);
  });

  it("2xx without an id: throws", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ notId: true }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeProvider().send(MSG)).rejects.toThrow(/without a message id/);
  });

  it("timeout/abort: throws (does not hang)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeProvider().send(MSG)).rejects.toThrow(
      /failed before a response/,
    );
    await expect(makeProvider().send(MSG)).rejects.toThrow(/TimeoutError/);
  });
});
