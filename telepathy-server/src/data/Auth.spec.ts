jest.mock("../OTelContext", () => {
  const span = { end: () => undefined };
  return {
    OTelLogger: () => ({
      createModuleLogger: () => ({
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      }),
    }),
    OTelTracer: () => ({ startSpan: () => span }),
    OTelRequestSpan: () => span,
    OTelSetTracer: () => undefined,
    OTelSetMeter: () => undefined,
    OTelMeter: () => undefined,
  };
});

import * as jwt from "jsonwebtoken";
import { Config } from "../Config";
import { User } from "../common-model/User";
import { Auth } from "./Auth";
import { SessionStart } from "./AuthSession";

const JWT_KEY = "test-jwt-key";
const VALIDITY = 3600;
const MAX_DURATION = 7776000;

const user = new User();
user.id = "11111111-1111-4111-8111-111111111111";
user.name = "alice";

function config(): Config {
  return {
    JWT_KEY,
    JWT_VALIDITY_DURATION: VALIDITY,
    JWT_SESSION_MAX_DURATION: MAX_DURATION,
  } as unknown as Config;
}

function forge(claims: Record<string, unknown>): string {
  return jwt.sign(claims, JWT_KEY, { algorithm: "HS256" });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

beforeAll(() => {
  Auth.init(config());
});

describe("Auth.generateJWT", () => {
  it("starts a session now and keeps the token within the validity", async () => {
    const token = await Auth.generateJWT(user);
    const claims = jwt.decode(token) as Record<string, unknown>;
    const start = SessionStart(claims) as number;
    expect(typeof start).toBe("number");
    expect(claims.user_id).toBe(user.id);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(
      VALIDITY
    );
  });

  it("preserves the session start and never extends beyond the cap", async () => {
    const now = nowSeconds();
    const start = now - 1000;
    const token = await Auth.generateJWT(user, start);
    const claims = jwt.decode(token) as Record<string, number>;
    expect(claims.sessionStartedAt).toBe(start);
    expect(claims.exp).toBeLessThanOrEqual(start + MAX_DURATION);
  });
});

describe("Auth.verifyToken", () => {
  it("returns claims for a valid token and null otherwise", () => {
    const now = nowSeconds();
    const token = forge({ user_id: user.id, iat: now, exp: now + VALIDITY });
    expect(Auth.verifyToken(token)?.user_id).toBe(user.id);
    expect(Auth.verifyToken("not-a-jwt")).toBeNull();
    expect(
      Auth.verifyToken(forge({ user_id: user.id, iat: now - 7200, exp: now - 60 }))
    ).toBeNull();
  });
});

describe("Auth.sessionCapReached", () => {
  it("reflects the configured absolute cap", () => {
    const now = nowSeconds();
    expect(Auth.sessionCapReached(now - MAX_DURATION - 1, now)).toBe(true);
    expect(Auth.sessionCapReached(now - 1000, now)).toBe(false);
  });
});
