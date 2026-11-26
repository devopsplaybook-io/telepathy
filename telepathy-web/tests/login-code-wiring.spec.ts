import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../services/AuthService";
import { EventBus, EventTypes } from "../services/EventBus";
import { getLoginCodeService } from "../utils/loginCodes";

const SERVER_TIME = "2026-11-26T12:00:00.000Z";

function capabilities() {
  return {
    enabled: true,
    available: true,
    codeLength: 8,
    rotationSeconds: 30,
    graceSeconds: 60,
    ttlSeconds: 300,
    pollIntervalMs: 2000,
    approveRequiresPassword: false,
    serverTime: SERVER_TIME,
  };
}

function base64Url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A real-shaped, unexpired JWT so AuthService.getToken() accepts it. */
function makeJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64Url({ alg: "HS256", typ: "JWT" }),
    base64Url({
      user_id: "user-1",
      user_name: "alice",
      iat: now,
      exp: now + 3600,
      sessionStartedAt: now,
    }),
    "signature",
  ].join(".");
}

function stubHttp(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockResolvedValue({ data: capabilities() }),
    post: vi.fn(),
    ...overrides,
  };
}

function serviceWith(http: ReturnType<typeof stubHttp>) {
  const service = getLoginCodeService();
  (service as unknown as { http: unknown }).http = http;
  return service;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("login code service wiring", () => {
  it("probes capabilities on the app's route prefix", async () => {
    const http = stubHttp();
    const service = serviceWith(http);

    const result = await service.capabilities();

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.get.mock.calls[0][0]).toBe(
      "/api/users/login-codes/capabilities"
    );
    expect(result.available).toBe(true);
    expect(result.codeLength).toBe(8);
  });

  it("persists an approved poll as the app session and announces it", async () => {
    const token = makeJwt();
    const http = stubHttp({
      post: vi.fn().mockResolvedValue({
        data: {
          status: "approved",
          token,
          user: { id: "user-1", name: "alice" },
          expiresAt: "2026-11-26T18:00:00.000Z",
          serverTime: SERVER_TIME,
        },
      }),
    });
    const service = serviceWith(http);

    const authEvents: unknown[] = [];
    const alerts: unknown[] = [];
    const onAuth = () => authEvents.push(true);
    const onAlert = (payload: unknown) => alerts.push(payload);
    EventBus.on(EventTypes.AUTH_UPDATED, onAuth);
    EventBus.on(EventTypes.ALERT_MESSAGE, onAlert);
    try {
      const result = await service.poll("request-token");

      expect(result.status).toBe("approved");
      expect(http.post.mock.calls[0][0]).toBe(
        "/api/users/login-codes/poll"
      );
      expect(localStorage.getItem("auth_token")).toBe(token);
      expect(await AuthService.getToken()).toBe(token);
      expect(authEvents).toHaveLength(1);
      expect(alerts).toEqual([
        { type: "info", text: "Authentication successful" },
      ]);
    } finally {
      EventBus.off(EventTypes.AUTH_UPDATED, onAuth);
      EventBus.off(EventTypes.ALERT_MESSAGE, onAlert);
    }
  });

  it("sends the stored bearer to preview and approve only", async () => {
    const token = makeJwt();
    await AuthService.saveToken(token);
    const http = stubHttp({
      post: vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            deviceLabel: "Chrome on macOS",
            userAgent: "Mozilla/5.0",
            createdAt: SERVER_TIME,
            expiresAt: "2026-11-26T12:05:00.000Z",
            userName: "alice",
            serverTime: SERVER_TIME,
          },
        })
        .mockResolvedValueOnce({
          data: { approved: true, expiresAt: SERVER_TIME, serverTime: SERVER_TIME },
        }),
    });
    const service = serviceWith(http);

    await service.capabilities();
    await service.preview("BCDFGHJK");
    await service.approve({ code: "BCDFGHJK" });

    const previewCall = http.post.mock.calls[0];
    expect(previewCall[0]).toBe("/api/users/login-codes/preview");
    expect(previewCall[2].headers.Authorization).toBe(`Bearer ${token}`);
    const approveCall = http.post.mock.calls[1];
    expect(approveCall[0]).toBe("/api/users/login-codes/approve");
    expect(approveCall[2].headers.Authorization).toBe(`Bearer ${token}`);
    // The device-side calls stay unauthenticated.
    expect(http.get.mock.calls[0][0]).toBe(
      "/api/users/login-codes/capabilities"
    );
  });

  it("sends no Authorization header when logged out", async () => {
    const http = stubHttp({
      post: vi.fn().mockResolvedValue({ data: { approved: true } }),
    });
    const service = serviceWith(http);

    await service.approve({ code: "BCDFGHJK" });

    expect(http.post.mock.calls[0][2].headers?.Authorization).toBeUndefined();
  });
});