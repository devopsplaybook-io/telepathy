export interface UserSession {
  isAuthenticated: boolean;
  userId?: string;
  issuedAt?: number;
  sessionStartedAt?: number;
}
