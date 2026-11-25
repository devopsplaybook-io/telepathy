import { jwtDecode } from "jwt-decode";
import { AuthService } from "./AuthService";

export const SESSION_REFRESH_URL = "/api/users/session/refresh";
export const RENEWAL_THRESHOLD = 0.2;
export const MIN_RENEWAL_INTERVAL_MS = 60_000;
export const FAILURE_COOLDOWN_MS = 60_000;
export const RENEWAL_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionClaims {
  iat?: number;
  exp?: number;
  sessionStartedAt?: number;
}

let inFlight: Promise<string | null> | null = null;
let lastAttemptAt = 0;
let cooldownUntil = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;
let onFocus: (() => void) | null = null;
let onVisibility: (() => void) | null = null;

export function DecodeSessionToken(token: string | null): SessionClaims | null {
  if (!token) return null;
  try {
    const decoded = jwtDecode<Record<string, unknown>>(token);
    if (!decoded || typeof decoded !== "object") return null;
    const claims: SessionClaims = {};
    if (typeof decoded.iat === "number") claims.iat = decoded.iat;
    if (typeof decoded.exp === "number") claims.exp = decoded.exp;
    if (typeof decoded.sessionStartedAt === "number") {
      claims.sessionStartedAt = decoded.sessionStartedAt;
    }
    return claims;
  } catch {
    return null;
  }
}

/** True when 20% or less of the token lifetime remains. */
export function TokenNeedsRenewal(
  token: string | null,
  nowMs: number = Date.now(),
): boolean {
  const claims = DecodeSessionToken(token);
  if (!claims || typeof claims.iat !== "number" || typeof claims.exp !== "number") {
    return false;
  }
  if (claims.exp <= claims.iat) return false;
  return (
    claims.exp * 1000 - nowMs <=
    (claims.exp - claims.iat) * 1000 * RENEWAL_THRESHOLD
  );
}

async function currentToken(): Promise<string | null> {
  try {
    return await AuthService.getToken();
  } catch {
    return null;
  }
}

export async function RenewSession(
  options: { force?: boolean } = {},
): Promise<string | null> {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return null;
  }
  if (inFlight) return inFlight;

  const now = Date.now();
  if (now - lastAttemptAt < MIN_RENEWAL_INTERVAL_MS) return null;
  if (now < cooldownUntil) return null;

  const token = await currentToken();
  if (!token) return null;
  if (!options.force && !TokenNeedsRenewal(token, now)) return null;

  lastAttemptAt = now;
  inFlight = (async () => {
    try {
      const response = await fetch(SESSION_REFRESH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (response.status === 201) {
        const body = (await response.json().catch(() => null)) as
          | { token?: unknown }
          | null;
        const renewed = body?.token;
        if (typeof renewed !== "string" || renewed.length === 0) return null;
        // A concurrent login may have replaced the token; never overwrite it.
        await AuthService.saveTokenIfCurrent(token, renewed);
        return renewed;
      }

      if (response.status === 401) {
        await AuthService.removeTokenIfCurrent(token);
        return null;
      }

      // 403 means the credential is not allowed to renew (for example an API
      // token): keep it. Server/network failures keep the token and pause.
      if (response.status >= 500) {
        cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
      }
      return null;
    } catch {
      cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function StartSessionRenewal(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (started) return;
  started = true;

  onFocus = () => {
    void RenewSession({ force: true });
  };
  onVisibility = () => {
    if (document.visibilityState === "visible") {
      void RenewSession({ force: true });
    }
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  timer = setInterval(() => {
    void RenewSession();
  }, RENEWAL_CHECK_INTERVAL_MS);

  void RenewSession({ force: true });
}

export function StopSessionRenewal(): void {
  if (onFocus) window.removeEventListener("focus", onFocus);
  if (onVisibility) {
    document.removeEventListener("visibilitychange", onVisibility);
  }
  if (timer !== null) clearInterval(timer);
  onFocus = null;
  onVisibility = null;
  timer = null;
  started = false;
}
