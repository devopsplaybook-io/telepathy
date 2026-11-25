import { ConfigBase } from "@devopsplaybook.io/common-utils";
import * as fse from "fs-extra";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("config");

export class Config extends ConfigBase {
  public AGENT_REGISTRATION_DURATION = 30 * 60;
  public TASK_HISTORY_MAX_COUNT = 100;
  public TASK_HISTORY_MAX_AGE_DAYS = 30;
  public TASK_ALIVE_TIMEOUT = 100;
  public FILE_REDUNDANCY = 2;
  public AGENT_KEY: string = uuidv4();
  // Previous configuration key, still accepted so existing deployments keep
  // exporting traces after the upgrade.
  public OPENTELEMETRY_COLLECTOR_HTTP = "";
  // Session policy: a token lives 30 days and the absolute session (from the
  // first login) is capped at 90 days. Both fields are inherited from
  // ConfigBase; they are re-declared here and re-registered below so the
  // values also survive a common-utils downgrade (whose ConfigBase captured
  // its own default in the base constructor).
  public JWT_VALIDITY_DURATION = 2592000;
  public JWT_SESSION_MAX_DURATION = 7776000;

  constructor() {
    super("telepathy-server", process.env.TELEPATHY_CONFIG || process.env.CONFIG_FILE);

    try {
      const pkg = fse.readJsonSync(path.resolve(__dirname, "../package.json"));
      if (pkg && pkg.version) {
        this.VERSION = pkg.version;
      }
    } catch {
      // Keep the ConfigBase default when running without a package manifest.
    }

    this.addConfigField({ field: "AGENT_REGISTRATION_DURATION" });
    this.addConfigField({ field: "TASK_HISTORY_MAX_COUNT" });
    this.addConfigField({ field: "TASK_HISTORY_MAX_AGE_DAYS" });
    this.addConfigField({ field: "TASK_ALIVE_TIMEOUT" });
    this.addConfigField({ field: "FILE_REDUNDANCY" });
    this.addConfigField({ field: "AGENT_KEY", sensitive: true });
    this.addConfigField({ field: "OPENTELEMETRY_COLLECTOR_HTTP" });
    this.addConfigField({ field: "JWT_VALIDITY_DURATION" });
    this.addConfigField({ field: "JWT_SESSION_MAX_DURATION" });
  }

  public async reload(): Promise<void> {
    await super.reload((message: string) => logger.info(message));
    if (!this.OPENTELEMETRY_COLLECTOR_HTTP_TRACES && this.OPENTELEMETRY_COLLECTOR_HTTP) {
      this.OPENTELEMETRY_COLLECTOR_HTTP_TRACES = this.OPENTELEMETRY_COLLECTOR_HTTP;
    }
  }
}
