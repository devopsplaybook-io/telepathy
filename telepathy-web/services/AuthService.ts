import { jwtDecode } from "jwt-decode";

const AUTH_TOKEN_KEY = "auth_token";

export class AuthService {
  //
  public static async isAuthenticated(): Promise<boolean> {
    if (await AuthService.getToken()) {
      return true;
    } else {
      return false;
    }
  }

  public static async saveToken(token: string): Promise<void> {
    await localStorage.setItem(AUTH_TOKEN_KEY, token);
  }

  public static async removeToken(): Promise<void> {
    await localStorage.removeItem(AUTH_TOKEN_KEY);
  }

  /**
   * Saves a renewed token only when the expected one is still stored, so a
   * concurrent login is never overwritten by an older renewal response.
   */
  public static async saveTokenIfCurrent(
    expected: string,
    token: string
  ): Promise<void> {
    try {
      if (localStorage.getItem(AUTH_TOKEN_KEY) === expected) {
        await AuthService.saveToken(token);
      }
    } catch {
      // Storage unavailable: nothing to update.
    }
  }

  public static async removeTokenIfCurrent(expected: string): Promise<void> {
    try {
      if (localStorage.getItem(AUTH_TOKEN_KEY) === expected) {
        await AuthService.removeToken();
      }
    } catch {
      // Storage unavailable: nothing to clear.
    }
  }

  public static async getToken() {
    try {
      if (typeof localStorage === "undefined") return null;
      const storedKey = localStorage.getItem(AUTH_TOKEN_KEY);
      if (!storedKey) {
        return null;
      }
      const decoded = jwtDecode(storedKey) as Record<string, unknown>;
      // A corrupt token must degrade to logged out instead of throwing during
      // store/navigation initialization.
      if (typeof decoded.exp !== "number") {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        return null;
      }
      if (decoded.exp < Date.now() / 1000) {
        console.log("Auth token expired");
        localStorage.removeItem(AUTH_TOKEN_KEY);
        return null;
      }
      return storedKey;
    } catch {
      try {
        localStorage.removeItem(AUTH_TOKEN_KEY);
      } catch {
        // Storage unavailable.
      }
      return null;
    }
  }

  public static async getAuthHeader(): Promise<any> {
    try {
      const token = await AuthService.getToken();
      if (token) {
        return {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        };
      } else {
        return {};
      }
    } catch (error) {
      return {};
    }
  }
}
