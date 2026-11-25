import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const NOW_MS = Date.parse("2026-06-01T00:00:00Z");
const NOW_S = Math.floor(NOW_MS / 1000);
const DAY = 24 * 3600;

function tokenWith(claims: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(JSON.stringify(claims));
  return `${header}.${body}.signature`;
}

function validToken(secondsLeft = 20 * DAY, lifetime = 30 * DAY): string {
  return tokenWith({ iat: NOW_S - (lifetime - secondsLeft), exp: NOW_S + secondsLeft });
}

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

type RenewalModule = typeof import("./SessionRenewal");

describe("SessionRenewal", () => {
  let mod: RenewalModule;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
    localStorage.clear();
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mod = await import("./SessionRenewal");
  });

  afterEach(() => {
    mod.StopSessionRenewal();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("TokenNeedsRenewal", () => {
    test("is false while more than 20% of the lifetime remains", () => {
      expect(mod.TokenNeedsRenewal(validToken(20 * DAY), NOW_MS)).toBe(false);
      expect(mod.TokenNeedsRenewal(validToken(10 * DAY), NOW_MS)).toBe(false);
    });

    test("is true at or below 20% of the lifetime", () => {
      expect(mod.TokenNeedsRenewal(validToken(6 * DAY), NOW_MS)).toBe(true);
      expect(mod.TokenNeedsRenewal(validToken(DAY), NOW_MS)).toBe(true);
      expect(
        mod.TokenNeedsRenewal(
          tokenWith({ iat: NOW_S - 80, exp: NOW_S + 20 }),
          NOW_MS,
        ),
      ).toBe(true);
    });

    test("is false for tokens without a usable lifetime", () => {
      expect(mod.TokenNeedsRenewal(null, NOW_MS)).toBe(false);
      expect(mod.TokenNeedsRenewal("not-a-jwt", NOW_MS)).toBe(false);
      expect(
        mod.TokenNeedsRenewal(tokenWith({ exp: NOW_S + DAY }), NOW_MS),
      ).toBe(false);
    });
  });

  test("does nothing without a stored token", async () => {
    await expect(mod.RenewSession({ force: true })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("renews a token below the threshold with the bearer token", async () => {
    const oldToken = validToken(DAY);
    localStorage.setItem("auth_token", oldToken);
    const newToken = validToken(30 * DAY);
    fetchMock.mockResolvedValueOnce(response(201, { success: true, token: newToken }));

    await expect(mod.RenewSession()).resolves.toBe(newToken);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/users/session/refresh",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: `Bearer ${oldToken}` },
      }),
    );
    expect(localStorage.getItem("auth_token")).toBe(newToken);
  });

  test("does not renew a token above the threshold unless forced", async () => {
    localStorage.setItem("auth_token", validToken(20 * DAY));
    await expect(mod.RenewSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const newToken = validToken(30 * DAY);
    fetchMock.mockResolvedValueOnce(response(201, { token: newToken }));
    await expect(mod.RenewSession({ force: true })).resolves.toBe(newToken);
  });

  test("renews on start and on focus, throttled to once per minute", async () => {
    localStorage.setItem("auth_token", validToken(20 * DAY));
    fetchMock.mockImplementation(async () => response(201, { token: localStorage.getItem("auth_token") }));

    mod.StartSessionRenewal();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("renews when the page becomes visible again", async () => {
    localStorage.setItem("auth_token", validToken(20 * DAY));
    fetchMock.mockImplementation(async () => response(201, { token: localStorage.getItem("auth_token") }));
    mod.StartSessionRenewal();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("hourly check only renews below the threshold", async () => {
    localStorage.setItem("auth_token", validToken(20 * DAY));
    fetchMock.mockImplementation(async () => response(201, { token: localStorage.getItem("auth_token") }));
    mod.StartSessionRenewal();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(mod.RENEWAL_CHECK_INTERVAL_MS);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    localStorage.setItem("auth_token", validToken(DAY));
    vi.advanceTimersByTime(mod.RENEWAL_CHECK_INTERVAL_MS);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("shares a single request between concurrent calls", async () => {
    const oldToken = validToken(DAY);
    localStorage.setItem("auth_token", oldToken);
    const newToken = validToken(30 * DAY);
    let resolveFetch: (value: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = mod.RenewSession({ force: true });
    await flush();
    const second = mod.RenewSession({ force: true });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(response(201, { token: newToken }));
    await expect(first).resolves.toBe(newToken);
    await expect(second).resolves.toBe(newToken);
  });

  test("does not overwrite a token changed while renewing", async () => {
    const oldToken = validToken(DAY);
    localStorage.setItem("auth_token", oldToken);
    let resolveFetch: (value: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const renewal = mod.RenewSession({ force: true });
    await flush();
    const otherToken = validToken(30 * DAY);
    localStorage.setItem("auth_token", otherToken);

    resolveFetch(response(201, { token: validToken(29 * DAY) }));
    await expect(renewal).resolves.toBeTruthy();
    expect(localStorage.getItem("auth_token")).toBe(otherToken);
  });

  test("clears the token on 401 only when it is still current", async () => {
    const oldToken = validToken(DAY);
    localStorage.setItem("auth_token", oldToken);
    fetchMock.mockResolvedValueOnce(response(401, { error: "Authentication Required" }));

    await expect(mod.RenewSession({ force: true })).resolves.toBeNull();
    expect(localStorage.getItem("auth_token")).toBeNull();
  });

  test("keeps the token on 403 and on server errors", async () => {
    const token = validToken(DAY);
    localStorage.setItem("auth_token", token);
    fetchMock.mockResolvedValueOnce(response(403, { error: "Forbidden" }));
    await expect(mod.RenewSession({ force: true })).resolves.toBeNull();
    expect(localStorage.getItem("auth_token")).toBe(token);

    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(response(503));
    await expect(mod.RenewSession({ force: true })).resolves.toBeNull();
    expect(localStorage.getItem("auth_token")).toBe(token);
  });

  test("cools down for one minute after a server error", async () => {
    localStorage.setItem("auth_token", validToken(DAY));
    fetchMock.mockResolvedValueOnce(response(500));
    await mod.RenewSession({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    await expect(mod.RenewSession({ force: true })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(response(201, { token: validToken(30 * DAY) }));
    await expect(mod.RenewSession({ force: true })).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("keeps the token when the network fails", async () => {
    const token = validToken(DAY);
    localStorage.setItem("auth_token", token);
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(mod.RenewSession({ force: true })).resolves.toBeNull();
    expect(localStorage.getItem("auth_token")).toBe(token);
  });
});
