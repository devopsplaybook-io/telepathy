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

import Fastify, { FastifyInstance } from "fastify";
import * as fs from "fs-extra";
import * as jwt from "jsonwebtoken";
import * as os from "os";
import * as path from "path";
import { Config } from "../Config";
import { Auth } from "../data/Auth";
import { FileDBUtils } from "../data/FileDbUtils";
import { UserPassword } from "../data/UserPassword";
import { UsersData } from "../data/UsersData";
import { User } from "../common-model/User";
import { UserRoutes } from "./UsersRoutes";

const JWT_KEY = "test-jwt-key";
const VALIDITY = 3600;
const MAX_DURATION = 7776000;

let tempDir: string;
let app: FastifyInstance;
let usersData: UsersData;
let user: User;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function forge(claims: Record<string, unknown>): string {
  return jwt.sign(claims, JWT_KEY, { algorithm: "HS256" });
}

function decode(token: string): Record<string, unknown> {
  return jwt.decode(token) as Record<string, unknown>;
}

async function refresh(token?: string) {
  return app.inject({
    method: "POST",
    url: "/api/users/session/refresh",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function login(token?: string, payload?: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/users/session",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: payload as never,
  });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "telepathy-users-"));
  const config = {
    JWT_KEY,
    JWT_VALIDITY_DURATION: VALIDITY,
    JWT_SESSION_MAX_DURATION: MAX_DURATION,
    DATA_DIR: tempDir,
    FILE_REDUNDANCY: 1,
  } as unknown as Config;
  Auth.init(config);
  FileDBUtils.init(config);

  usersData = new UsersData();
  await usersData.load(undefined);
  user = new User();
  user.name = "alice";
  await UserPassword.setPassword(undefined, user, "secret123");
  usersData.users.push(user);

  app = Fastify();
  app.register(new UserRoutes(usersData).getRoutes, { prefix: "/api/users" });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  fs.removeSync(tempDir);
});

describe("POST /api/users/session/refresh", () => {
  it("reissues a token that keeps the original session start", async () => {
    const now = nowSeconds();
    const start = now - 1000;
    const res = await refresh(
      forge({
        user_id: user.id,
        iat: now - 1000,
        sessionStartedAt: start,
        exp: now + VALIDITY,
      })
    );

    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.success).toBe(true);
    const claims = decode(body.token) as Record<string, number>;
    expect(claims.sessionStartedAt).toBe(start);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(VALIDITY);
    expect(claims.exp).toBeLessThanOrEqual(start + MAX_DURATION);
  });

  it("falls back to iat for tokens issued before sliding sessions", async () => {
    const now = nowSeconds();
    const iat = now - 500;
    const res = await refresh(
      forge({ user_id: user.id, iat, exp: now + VALIDITY })
    );

    expect(res.statusCode).toBe(201);
    const claims = decode(res.json().token) as Record<string, number>;
    expect(claims.sessionStartedAt).toBe(iat);
  });

  it("rejects a missing, malformed or expired bearer", async () => {
    expect((await refresh()).statusCode).toBe(401);
    expect((await refresh("not-a-jwt")).statusCode).toBe(401);
    const now = nowSeconds();
    const expired = forge({ user_id: user.id, iat: now - 7200, exp: now - 60 });
    expect((await refresh(expired)).statusCode).toBe(401);
  });

  it("rejects a token whose user no longer exists", async () => {
    const now = nowSeconds();
    const res = await refresh(
      forge({ user_id: "unknown-user", iat: now, exp: now + VALIDITY })
    );
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token once the absolute session cap is reached", async () => {
    const now = nowSeconds();
    const res = await refresh(
      forge({
        user_id: user.id,
        iat: now - MAX_DURATION - 10,
        sessionStartedAt: now - MAX_DURATION - 10,
        exp: now + 100,
      })
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Session Expired");
  });
});

describe("POST /api/users/session", () => {
  it("keeps the username/password login as the start of a new session", async () => {
    const res = await login(undefined, {
      name: user.name,
      password: "secret123",
    });

    expect(res.statusCode).toBe(201);
    const claims = decode(res.json().token) as Record<string, number>;
    expect(typeof claims.sessionStartedAt).toBe("number");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(VALIDITY);
  });

  it("reissues a bearer-only request with the original session start", async () => {
    const now = nowSeconds();
    const start = now - 2000;
    const res = await login(
      forge({
        user_id: user.id,
        iat: now - 2000,
        sessionStartedAt: start,
        exp: now + VALIDITY,
      })
    );

    expect(res.statusCode).toBe(201);
    const claims = decode(res.json().token) as Record<string, number>;
    expect(claims.sessionStartedAt).toBe(start);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("rejects a bearer-only request once the absolute cap is reached", async () => {
    const now = nowSeconds();
    const res = await login(
      forge({
        user_id: user.id,
        iat: now - MAX_DURATION - 10,
        sessionStartedAt: now - MAX_DURATION - 10,
        exp: now + 100,
      })
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Session Expired");
  });

  it("still rejects invalid credentials", async () => {
    const res = await login(undefined, {
      name: user.name,
      password: "wrong-password",
    });
    expect(res.statusCode).toBe(403);
  });
});
