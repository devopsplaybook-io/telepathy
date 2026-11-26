import {
  LoginCodesOptionsFromConfig,
  LoginCodesRoutes,
  LoginCodesRoutesOptions,
} from "@devopsplaybook.io/common-utils/users/login-codes";
import { FastifyInstance } from "fastify";
import { User } from "../common-model/User";
import { Config } from "../Config";
import { Auth } from "../data/Auth";
import { LoginCodesFileStore } from "../data/LoginCodesFileStore";
import { UserPassword } from "../data/UserPassword";
import { UsersData } from "../data/UsersData";
import { OTelLogger, OTelRequestSpan } from "../OTelContext";

const logger = OTelLogger().createModuleLogger("login-codes");

/**
 * Build the login-code plugin with telepathy's custom auth hooks.
 *
 * The routes are always registered: `LOGIN_CODE_ENABLED` controls the
 * capabilities answer and the `503` on mutating routes, which is what lets the
 * web cards hide themselves cleanly.
 */
export function LoginCodesFeature(config: Config, usersData: UsersData) {
  const store = new LoginCodesFileStore(config);
  const options: LoginCodesRoutesOptions = {
    ...LoginCodesOptionsFromConfig(config),
    store,
    hashKey: () => config.JWT_KEY,
    getApprovingUser: async (req) => {
      // Only the app's JWT bearer is an interactive credential; the agent
      // `x-agent-key` header is not accepted as an approver.
      const session = await Auth.getUserSession(req);
      if (!session.isAuthenticated || !session.userId) return null;
      const user = await usersData.get(OTelRequestSpan(req), session.userId);
      if (!user) return null;
      return { id: user.id, name: user.name, isApiToken: false };
    },
    getUserById: async (id) => {
      // Re-read live at redemption so a deleted approver fails closed.
      const user = await usersData.get(undefined, id);
      return user ? { id: user.id, name: user.name } : null;
    },
    issueSession: async (approver) => {
      // Same token and claims as the password login: a fresh session start.
      const user = User.fromJson({ id: approver.id, name: approver.name });
      const token = await Auth.generateJWT(user);
      return { token, user: { id: user.id, name: user.name } };
    },
    verifyPassword: async (approver, password) => {
      const user = await usersData.get(undefined, approver.id);
      if (!user || !user.passwordEncrypted) return false;
      return UserPassword.checkPassword(undefined, user, password);
    },
    onEvent: (event) => {
      // Audit only identifiers: no codes, request tokens or session tokens.
      logger.info(
        `login_code event=${event.type} request=${event.requestId}` +
          ` user=${event.userId ?? "-"} device=${event.deviceLabel ?? "-"}` +
          ` reason=${event.reason ?? "-"} ip=${event.ip ?? "-"}`
      );
    },
  };

  return async function loginCodesRoutes(
    fastify: FastifyInstance
  ): Promise<void> {
    // The outer registration supplies the `/api/users/login-codes` prefix.
    await fastify.register(LoginCodesRoutes, options);
  };
}