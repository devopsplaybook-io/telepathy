export interface SessionTokenClaims {
  user_id?: unknown;
  user_name?: unknown;
  iat?: unknown;
  exp?: unknown;
  sessionStartedAt?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** First login of the chain, falling back to the token issue time. */
export function SessionStart(claims: SessionTokenClaims): number | undefined {
  return finiteNumber(claims.sessionStartedAt) ?? finiteNumber(claims.iat);
}

export function SessionCapReached(
  sessionStartedAt: number | undefined,
  sessionMaxDuration: number,
  nowSeconds: number,
): boolean {
  if (!Number.isFinite(sessionMaxDuration) || sessionMaxDuration <= 0) {
    return false;
  }
  if (sessionStartedAt === undefined) return false;
  return nowSeconds >= sessionStartedAt + sessionMaxDuration;
}

/** Now + validity, never beyond the absolute session cap. */
export function SessionExpiry(
  sessionStartedAt: number,
  sessionValidity: number,
  sessionMaxDuration: number,
  nowSeconds: number,
): number {
  const expiry = nowSeconds + sessionValidity;
  if (!Number.isFinite(sessionMaxDuration) || sessionMaxDuration <= 0) {
    return expiry;
  }
  return Math.min(expiry, sessionStartedAt + sessionMaxDuration);
}
