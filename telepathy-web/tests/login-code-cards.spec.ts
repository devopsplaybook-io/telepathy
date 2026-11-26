import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthorizeDeviceCard from "@devopsplaybook.io/common-web/components/AuthorizeDeviceCard.vue";
import LoginWithCodeCard from "@devopsplaybook.io/common-web/components/LoginWithCodeCard.vue";
import type { LoginCodeService } from "@devopsplaybook.io/common-web/services/LoginCodeService";

const SERVER_TIME = "2026-11-26T12:00:00.000Z";

function capabilities(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function asService(service: object): LoginCodeService {
  return service as unknown as LoginCodeService;
}

async function settle(turns = 40): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

const wrappers: VueWrapper[] = [];

function mountCard(
  component: Parameters<typeof mount>[0],
  props: Record<string, unknown>
): VueWrapper {
  const wrapper = mount(component, { props });
  wrappers.push(wrapper);
  return wrapper;
}

function buttonWithText(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll("button").find((entry) => entry.text() === text);
  if (!button) throw new Error(`button "${text}" not found`);
  return button;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LoginWithCodeCard", () => {
  it("hides the flow when the feature is unavailable", async () => {
    const service = {
      capabilities: vi
        .fn()
        .mockResolvedValue(capabilities({ enabled: false, available: false })),
      create: vi.fn(),
      poll: vi.fn(),
      cancel: vi.fn(),
    };
    const wrapper = mountCard(LoginWithCodeCard, {
      service: asService(service),
      headingLevel: 3,
    });
    await settle();

    expect(wrapper.get("h3").text()).toBe("Sign in with a code");
    expect(wrapper.text()).toContain(
      "Login with a code is unavailable. Use your password instead."
    );
    expect(service.create).not.toHaveBeenCalled();
    expect(wrapper.find(".login-with-code-value").exists()).toBe(false);
  });

  it("shows the code and reports the redeemed session", async () => {
    const service = {
      capabilities: vi.fn().mockResolvedValue(capabilities()),
      create: vi.fn().mockResolvedValue({
        requestToken: "request-token",
        code: "BCDFGHJK",
        codeExpiresAt: "2026-11-26T12:00:30.000Z",
        expiresAt: "2026-11-26T12:05:00.000Z",
        serverTime: SERVER_TIME,
      }),
      poll: vi.fn().mockResolvedValue({
        status: "approved",
        token: "jwt",
        user: { id: "user-1", name: "alice" },
        expiresAt: "2026-11-26T12:05:00.000Z",
        serverTime: SERVER_TIME,
      }),
      cancel: vi.fn(),
    };
    const wrapper = mountCard(LoginWithCodeCard, {
      service: asService(service),
      headingLevel: 3,
    });
    await settle();

    expect(wrapper.get(".login-with-code-value").text()).toBe("BCDF-GHJK");
    expect(wrapper.get('[role="status"]').text()).toBe(
      "Waiting for approval"
    );

    await vi.advanceTimersByTimeAsync(2000);
    await settle();

    expect(wrapper.get('[role="status"]').text()).toBe("Approved");
    expect(wrapper.emitted("approved")).toEqual([
      [{ token: "jwt", user: { id: "user-1", name: "alice" } }],
    ]);
  });
});

describe("AuthorizeDeviceCard", () => {
  it("hides the form when the feature is unavailable", async () => {
    const service = {
      capabilities: vi
        .fn()
        .mockResolvedValue(capabilities({ enabled: false, available: false })),
      preview: vi.fn(),
      approve: vi.fn(),
    };
    const wrapper = mountCard(AuthorizeDeviceCard, {
      service: asService(service),
      headingLevel: 2,
    });
    await settle();

    expect(wrapper.get("h2").text()).toBe("Approve a sign-in");
    expect(wrapper.text()).toContain("Login with a code is unavailable");
    expect(wrapper.find("input[type='text']").attributes("disabled")).toBeDefined();
  });

  it("previews and approves a code", async () => {
    const service = {
      capabilities: vi.fn().mockResolvedValue(capabilities()),
      preview: vi.fn().mockResolvedValue({
        deviceLabel: "Chrome on macOS",
        userAgent: "Mozilla/5.0 (Macintosh)",
        createdAt: "2026-11-26T12:00:00.000Z",
        expiresAt: "2026-11-26T12:05:00.000Z",
        userName: "alice",
        serverTime: SERVER_TIME,
      }),
      approve: vi.fn().mockResolvedValue({
        approved: true,
        expiresAt: "2026-11-26T12:05:00.000Z",
        serverTime: SERVER_TIME,
      }),
    };
    const wrapper = mountCard(AuthorizeDeviceCard, {
      service: asService(service),
      headingLevel: 2,
    });
    await settle();

    await wrapper.get("input[type='text']").setValue("bcdf-ghjk");
    await wrapper.get("form").trigger("submit");
    await settle();

    expect(service.preview).toHaveBeenCalledWith("BCDFGHJK", expect.anything());
    expect(wrapper.text()).toContain("Chrome on macOS");
    expect(wrapper.text()).toContain("alice");

    await buttonWithText(wrapper, "Approve sign-in").trigger("click");
    await settle();

    expect(service.approve).toHaveBeenCalledWith(
      { code: "BCDFGHJK", password: undefined },
      expect.anything()
    );
    expect(wrapper.emitted("approved")).toHaveLength(1);
    expect(wrapper.text()).toContain("Sign-in approved");
  });
});