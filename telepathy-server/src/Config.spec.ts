import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  AuthSessionPolicyCheck,
  AuthSessionPolicyLog,
  ConfigBase,
} from "@devopsplaybook.io/common-utils";
import { Config } from "./Config";

const ENV_KEYS = [
  "JWT_VALIDITY_DURATION",
  "JWT_SESSION_MAX_DURATION",
  "CONFIG_FILE",
  "TELEPATHY_CONFIG",
  "LOGIN_CODE_ENABLED",
] as const;

describe("Config JWT session durations", () => {
  const originalEnv: Record<string, string | undefined> = {};
  let tempDir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      Reflect.deleteProperty(process.env, key);
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "telepathy-config-"));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    fs.removeSync(tempDir);
  });

  function configFile(content: Record<string, unknown>): string {
    const file = path.join(tempDir, "config.json");
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  }

  it("loads the explicit 30-day validity and 90-day cap from the config file", async () => {
    process.env.CONFIG_FILE = configFile({
      DATA_DIR: tempDir,
      JWT_VALIDITY_DURATION: 2592000,
      JWT_SESSION_MAX_DURATION: 7776000,
    });
    const config = new Config();
    await config.reload();
    expect(config.JWT_VALIDITY_DURATION).toBe(2592000);
    expect(config.JWT_SESSION_MAX_DURATION).toBe(7776000);
  });

  it("coerces string environment overrides to numbers", async () => {
    process.env.CONFIG_FILE = configFile({
      DATA_DIR: tempDir,
      JWT_VALIDITY_DURATION: 2592000,
      JWT_SESSION_MAX_DURATION: 7776000,
    });
    process.env.JWT_VALIDITY_DURATION = "3600";
    process.env.JWT_SESSION_MAX_DURATION = "7200";
    const config = new Config();
    await config.reload();
    expect(config.JWT_VALIDITY_DURATION).toBe(3600);
    expect(config.JWT_SESSION_MAX_DURATION).toBe(7200);
  });

  it("matches the documented session policy", async () => {
    process.env.CONFIG_FILE = configFile({
      DATA_DIR: tempDir,
      JWT_VALIDITY_DURATION: 2592000,
      JWT_SESSION_MAX_DURATION: 7776000,
    });
    const config = new Config();
    await config.reload();

    const result = AuthSessionPolicyCheck(config, { app: "telepathy" });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("logs the effective session values and the policy line at startup", async () => {
    process.env.CONFIG_FILE = configFile({ DATA_DIR: tempDir });
    const config = new Config();
    const lines: string[] = [];
    await ConfigBase.prototype.reload.call(config, (message: string) =>
      lines.push(message),
    );
    AuthSessionPolicyLog(config, {
      app: "telepathy",
      logger: (message: string) => lines.push(message),
    });

    expect(lines).toContain(
      "Configuration Value: JWT_VALIDITY_DURATION: 2592000 (from defaults)",
    );
    expect(lines).toContain(
      "Configuration Value: JWT_SESSION_MAX_DURATION: 7776000 (from defaults)",
    );
    expect(lines).toContain(
      "Auth session policy: app=telepathy validity=2592000s cap=7776000s renewal=sliding status=ok",
    );
  });

  it("reports an error line when the validity is below the minimum", async () => {
    process.env.CONFIG_FILE = configFile({ DATA_DIR: tempDir });
    process.env.JWT_VALIDITY_DURATION = "60";
    const config = new Config();
    const lines: string[] = [];
    await ConfigBase.prototype.reload.call(config, (message: string) =>
      lines.push(message),
    );
    AuthSessionPolicyLog(config, {
      app: "telepathy",
      logger: (message: string) => lines.push(message),
    });

    expect(lines).toContain(
      "Auth session policy error: JWT_VALIDITY_DURATION 60s is below the 3600s minimum; declare an explicit exception for a deliberately short session",
    );
  });

  it("keeps login-with-code disabled by default and coerces the env flag", async () => {
    process.env.CONFIG_FILE = configFile({ DATA_DIR: tempDir });
    const config = new Config();
    await config.reload();
    expect(config.LOGIN_CODE_ENABLED).toBe(false);

    process.env.LOGIN_CODE_ENABLED = "true";
    await config.reload();
    expect(config.LOGIN_CODE_ENABLED).toBe(true);
  });

  it("ships explicit durations in the docker config without a fixed JWT key", () => {
    const dockerConfig = fs.readJSONSync(
      path.resolve(__dirname, "../../config-docker/config-server.json")
    );
    expect(dockerConfig.JWT_VALIDITY_DURATION).toBe(2592000);
    expect(dockerConfig.JWT_SESSION_MAX_DURATION).toBe(7776000);
    expect(dockerConfig.JWT_KEY).toBe("TO_CHANGE");
  });
});
