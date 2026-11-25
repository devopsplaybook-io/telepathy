import * as jwt from "jsonwebtoken";
import * as path from "path";
import { User } from "../common-model/User";
import { UserSession } from "../common-model/UserSession";
import { Config } from "../Config";
import { OTelLogger } from "../OTelContext";
import {
  SessionCapReached,
  SessionExpiry,
  SessionStart,
  SessionTokenClaims,
} from "./AuthSession";

const logger = OTelLogger().createModuleLogger(path.basename(__filename));
let config: Config;

export class Auth {
  //
  public static init(configIn: Config) {
    config = configIn;
  }

  public static async generateJWT(
    user: User,
    sessionStartedAt?: number
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const start = sessionStartedAt ?? now;
    return jwt.sign(
      {
        exp: SessionExpiry(
          start,
          Number(config.JWT_VALIDITY_DURATION),
          Number(config.JWT_SESSION_MAX_DURATION),
          now
        ),
        iat: now,
        sessionStartedAt: start,
        user_id: user.id,
        user_name: user.name,
      },
      config.JWT_KEY,
      { algorithm: "HS256" }
    );
  }

  public static verifyToken(token: string): SessionTokenClaims | null {
    try {
      return jwt.verify(token, config.JWT_KEY, {
        algorithms: ["HS256"],
      }) as SessionTokenClaims;
    } catch {
      return null;
    }
  }

  public static sessionCapReached(
    sessionStartedAt: number | undefined,
    nowSeconds: number
  ): boolean {
    return SessionCapReached(
      sessionStartedAt,
      Number(config.JWT_SESSION_MAX_DURATION),
      nowSeconds
    );
  }

  public static async checkToken(token: string): Promise<any> {
    const info = Auth.verifyToken(token);
    if (info) {
      return { authenticated: true, info };
    }
    return {
      authenticated: false,
    };
  }

  public static async mustBeAuthenticated(req: any, res: any): Promise<void> {
    let authenticated = false;
    if (req.headers.authorization) {
      if (Auth.verifyToken(req.headers.authorization.split(" ")[1])) {
        authenticated = true;
      }
    }
    if (!authenticated) {
      res.status(403).send({ error: "Access Denied" });
      throw new Error("Access Denied");
    }
  }

  public static async getUserSession(req: any): Promise<UserSession> {
    const userSession: UserSession = { isAuthenticated: false };
    if (req.headers.authorization) {
      try {
        const claims = Auth.verifyToken(
          req.headers.authorization.split(" ")[1]
        );
        if (claims) {
          userSession.userId =
            typeof claims.user_id === "string" ? claims.user_id : undefined;
          userSession.issuedAt =
            typeof claims.iat === "number" ? claims.iat : undefined;
          userSession.sessionStartedAt = SessionStart(claims);
          userSession.isAuthenticated = true;
        }
      } catch (err) {
        logger.error("Failed to decode user session", err as Error);
      }
    }
    return userSession;
  }
}
