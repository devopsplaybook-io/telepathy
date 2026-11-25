import { SessionCapReached, SessionExpiry, SessionStart } from "./AuthSession";

describe("SessionStart", () => {
  it("prefers sessionStartedAt and falls back to iat", () => {
    expect(SessionStart({ sessionStartedAt: 100, iat: 50 })).toBe(100);
    expect(SessionStart({ iat: 50 })).toBe(50);
    expect(SessionStart({})).toBeUndefined();
    expect(SessionStart({ sessionStartedAt: "x", iat: 50 })).toBe(50);
  });
});

describe("SessionCapReached", () => {
  it("is reached at or after start + max", () => {
    expect(SessionCapReached(1000, 500, 1499)).toBe(false);
    expect(SessionCapReached(1000, 500, 1500)).toBe(true);
    expect(SessionCapReached(1000, 500, 1600)).toBe(true);
  });

  it("is never reached without a start or a positive max", () => {
    expect(SessionCapReached(undefined, 500, 10_000)).toBe(false);
    expect(SessionCapReached(1000, 0, 10_000)).toBe(false);
    expect(SessionCapReached(1000, Number.NaN, 10_000)).toBe(false);
  });
});

describe("SessionExpiry", () => {
  it("is now + validity when the cap is far away", () => {
    expect(SessionExpiry(1000, 3600, 90_000, 1500)).toBe(5100);
  });

  it("is clamped to the absolute session cap", () => {
    expect(SessionExpiry(1000, 3600, 1000, 1500)).toBe(2000);
  });

  it("ignores a missing or non-positive cap", () => {
    expect(SessionExpiry(1000, 3600, 0, 1500)).toBe(5100);
    expect(SessionExpiry(1000, 3600, Number.NaN, 1500)).toBe(5100);
  });
});
