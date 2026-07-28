import { describe, expect, test } from "bun:test";
import { ApiError, getJson } from "../src/ui/api.ts";

describe("getJson", () => {
  test("preserves the server error code, prose, status, and extras", async () => {
    const fetcher = () =>
      Promise.resolve(
        Response.json(
          {
            error: "archive is busy",
            code: "archive_locked",
            retryable: true,
          },
          { status: 503 },
        ),
      );

    try {
      await getJson("/api/test", undefined, fetcher, {
        delaysMs: [],
        wait: () => Promise.resolve(),
      });
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        code: "archive_locked",
        message: "archive is busy",
        status: 503,
        extras: { retryable: true },
      });
    }
  });

  test("uses an HTTP fallback when the body is not JSON", async () => {
    const fetcher = () =>
      Promise.resolve(new Response("broken", { status: 502, statusText: "Bad Gateway" }));
    await expect(getJson("/api/test", undefined, fetcher)).rejects.toMatchObject({
      code: "request_failed",
      message: "502 Bad Gateway",
    });
  });

  test("absorbs transient archive locks before surfacing an error", async () => {
    let attempts = 0;
    const fetcher = () => {
      attempts += 1;
      return Promise.resolve(
        attempts < 3
          ? Response.json(
              { error: "database is locked", code: "archive_locked", retryable: true },
              { status: 503 },
            )
          : Response.json({ ok: true }),
      );
    };
    await expect(
      getJson("/api/test", undefined, fetcher, {
        delaysMs: [0, 0, 0],
        wait: () => Promise.resolve(),
      }),
    ).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
  });
});
