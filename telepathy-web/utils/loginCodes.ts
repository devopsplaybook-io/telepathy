import {
  createLoginCodeService,
  LoginCodeService,
} from "@devopsplaybook.io/common-web/services/LoginCodeService";
import { AuthService } from "../services/AuthService";
import { EventBus, EventTypes } from "../services/EventBus";

/**
 * Persist a session redeemed through a login code exactly like the password
 * form does: store the token, then refresh the navigation and show the alert.
 * Session renewal is owned by the global client plugin.
 */
export async function persistLoginCodeSession(token: string): Promise<void> {
  await AuthService.saveToken(token);
  EventBus.emit(EventTypes.AUTH_UPDATED, {});
  EventBus.emit(EventTypes.ALERT_MESSAGE, {
    type: "info",
    text: "Authentication successful",
  });
}

let loginCodeService: LoginCodeService | null = null;

/** Shared client for the `/api/users/login-codes` route prefix. */
export function getLoginCodeService(): LoginCodeService {
  if (!loginCodeService) {
    loginCodeService = createLoginCodeService({
      baseUrl: "/api/users/login-codes",
      getAuthHeader: () => AuthService.getAuthHeader(),
      onSession: persistLoginCodeSession,
    });
  }
  return loginCodeService;
}