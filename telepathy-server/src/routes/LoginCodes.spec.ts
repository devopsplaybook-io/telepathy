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
import { User } from "../common-model/User";
import { Config } from "../Config";
import { Auth } from "../data/Auth";
import { FileDBUtils } from "../data/FileDbUtils";
import { UserPassword } from "../data/UserPassword";
import { UsersData } from "../data/UsersData";
import { LoginCodesFeature } from "./LoginCodes";

const PREFIX = "/api/users/login-codes";
const JWT_KEY = "test-jwt-key";
const VALIDITY = 3600;

let tempDir: string;
let usersData: UsersData;
let user: User;
let aliceToken: string;
let enabledApp: FastifyInstance;
let disabledApp: FastifyInstance;
let stepUpApp: FastifyInstance;

function baseConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    DATA_DIR: tempDir,
    FILE_REDUNDANCY: 1,
    JWT_KEY,
    JWT_VALIDITY_DURATION: VALIDITY,
    JWT_SESSION_MAX_DURATION: 7776000,
    LOGIN_CODE_ENABLED: true,
    // Disable the per-IP limits so the tests exercise the protocol, not 429s.
    LOGIN_CODE_RATE_LIMIT_CREATE_MAX: 0,
    LOGIN_CODE_RATE_LIMIT_POLL_MAX: 0,
    LOGIN_CODE_RATE_LIMIT_APPROVE_MAX: 0,
    ...overrides,
  } as unknown as Config;
}

async function buildApp(appConfig: Config): Promise<FastifyInstance> {
  const app = Fastify({ routerOptions: { ignoreTrailingSlash: true } });
  app.register(LoginCodesFeature(appConfig, usersData), { prefix: PREFIX });
  await app.ready();
  return app;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function createCode(app: FastifyInstance) {
  const res = await app.inject({ method: "POST", url: `${PREFIX}/` });
  return { res, body: res.json() };
}

async function preview(app: FastifyInstance, code: string, token?: string) {
  return app.inject({
    method: "POST",
    url: `${PREFIX}/preview`,
    headers: token ? bearer(token) : {},
    payload: { code },
  });
}

async function approve(
  app: FastifyInstance,
  code: string,
  token?: string,
  password?: string
) {
  return app.inject({
    method: "POST",
    url: `${PREFIX}/approve`,
    headers: token ? bearer(token) : {},
    payload: { code, password },
  });
}

async function poll(app: FastifyInstance, requestToken: string) {
  return app.inject({
    method: "POST",
    url: `${PREFIX}/poll`,
    payload: { requestToken },
  });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "telepathy-login-routes-"));
  const config = baseConfig();
  Auth.init(config);
  FileDBUtils.init(config);

  usersData = new UsersData();
  await usersData.load(undefined);
  user = new User();
  user.name = "alice";
  await UserPassword.setPassword(undefined, user, "secret123");
  usersData.users.push(user);
  aliceToken = await Auth.generateJWT(user);

  enabledApp = await buildApp(baseConfig());
  disabledApp = await buildApp(baseConfig({ LOGIN_CODE_ENABLED: false }));
  stepUpApp = await buildApp(
    baseConfig({ LOGIN_CODE_APPROVE_REQUIRE_PASSWORD: true })
  );
});

afterAll(async () => {
  await enabledApp?.close();
  await disabledApp?.close();
  await stepUpApp?.close();
  fs.removeSync(tempDir);
});

describe("GET /api/users/login-codes/capabilities", () => {
  it("reports the enabled and available feature without caching", async () => {
    const res = await enabledApp.inject({
      method: "GET",
      url: `${PREFIX}/capabilities`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.available).toBe(true);
    expect(body.codeLength).toBe(8);
    expect(body.approveRequiresPassword).toBe(false);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["pragma"]).toBe("no-cache");
    expect(res.headers.vary).toBe("Authorization");
  });

  it("reports disabled without failing", async () => {
    const res = await disabledApp.inject({
      method: "GET",
      url: `${PREFIX}/capabilities`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
    expect(res.json().available).toBe(false);
  });

  it("answers 503 on mutating routes when disabled", async () => {
    const res = await disabledApp.inject({
      method: "POST",
      url: `${PREFIX}/`,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("LOGIN_CODE_UNAVAILABLE");
  });
});

describe("approval requires an interactive session", () => {
  it("rejects a preview without a credential", async () => {
    const { body } = await createCode(enabledApp);
    const res = await preview(enabledApp, body.code);

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHENTICATED");
  });

  it("rejects a forged bearer token", async () => {
    const { body } = await createCode(enabledApp);
    const forged = jwt.sign(
      { user_id: user.id, iat: nowSeconds(), exp: nowSeconds() + VALIDITY },
      "not-the-signing-key",
      { algorithm: "HS256" }
    );
    const res = await preview(enabledApp, body.code, forged);

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHENTICATED");
  });

  it("rejects a valid token whose user no longer exists", async () => {
    const { body } = await createCode(enabledApp);
    const deleted = jwt.sign(
      { user_id: "deleted-user", iat: nowSeconds(), exp: nowSeconds() + VALIDITY },
      JWT_KEY,
      { algorithm: "HS256" }
    );
    const res = await preview(enabledApp, body.code, deleted);

    expect(res.statusCode).toBe(401);
  });

  it("does not treat an agent key as an interactive session", async () => {
    const { body } = await createCode(enabledApp);
    const res = await enabledApp.inject({
      method: "POST",
      url: `${PREFIX}/preview`,
      headers: { "x-agent-key": "agent-secret" },
      payload: { code: body.code },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHENTICATED");
  });

  it("rejects an approval without a credential", async () => {
    const { body } = await createCode(enabledApp);
    const res = await approve(enabledApp, body.code);

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHENTICATED");
  });
});

describe("create → preview → approve → poll", () => {
  it("redeems one session and refuses the second poll", async () => {
    const { res: createRes, body: created } = await createCode(enabledApp);
    expect(createRes.statusCode).toBe(201);
    expect(createRes.headers["cache-control"]).toBe("no-store");
    expect(typeof created.requestToken).toBe("string");
    expect(created.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);

    const previewRes = await preview(enabledApp, created.code, aliceToken);
    expect(previewRes.statusCode).toBe(200);
    const previewBody = previewRes.json();
    expect(previewBody.userName).toBe("alice");
    expect(typeof previewBody.deviceLabel).toBe("string");
    expect(previewBody.serverTime).toBeDefined();

    const approveRes = await approve(enabledApp, created.code, aliceToken);
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().approved).toBe(true);

    const pollRes = await poll(enabledApp, created.requestToken);
    expect(pollRes.statusCode).toBe(200);
    expect(pollRes.headers["cache-control"]).toBe("no-store");
    const pollBody = pollRes.json();
    expect(pollBody.status).toBe("approved");
    expect(pollBody.user).toEqual({ id: user.id, name: user.name });

    const claims = jwt.decode(pollBody.token) as Record<string, number>;
    expect(claims.user_id).toBe(user.id);
    expect(claims.user_name).toBe("alice");
    expect(typeof claims.sessionStartedAt).toBe("number");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(VALIDITY);
    expect(claims.exp).toBeGreaterThan(claims.iat);

    const secondPoll = await poll(enabledApp, created.requestToken);
    expect(secondPoll.statusCode).toBe(409);
    expect(secondPoll.json().code).toBe("ALREADY_USED");
  });

  it("cancels a pending request idempotently and never issues a session", async () => {
    const { body: created } = await createCode(enabledApp);

    const cancelRes = await enabledApp.inject({
      method: "POST",
      url: `${PREFIX}/cancel`,
      payload: { requestToken: created.requestToken },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().status).toBe("cancelled");

    const secondCancel = await enabledApp.inject({
      method: "POST",
      url: `${PREFIX}/cancel`,
      payload: { requestToken: created.requestToken },
    });
    expect(secondCancel.statusCode).toBe(200);

    const pollRes = await poll(enabledApp, created.requestToken);
    expect(pollRes.statusCode).toBe(200);
    expect(pollRes.json().status).toBe("cancelled");
    expect(pollRes.json().token).toBeUndefined();
  });

  it("answers INVALID_CODE for an unknown request token", async () => {
    const res = await poll(enabledApp, "unknown-request-token");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_CODE");
  });
});

describe("password step-up", () => {
  it("requires, checks and accepts the account password", async () => {
    const { body: created } = await createCode(stepUpApp);

    const missing = await approve(stepUpApp, created.code, aliceToken);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("PASSWORD_REQUIRED");

    const wrong = await approve(stepUpApp, created.code, aliceToken, "wrong");
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe("INVALID_CODE");

    const correct = await approve(
      stepUpApp,
      created.code,
      aliceToken,
      "secret123"
    );
    expect(correct.statusCode).toBe(200);
    expect(correct.json().approved).toBe(true);
  });
});