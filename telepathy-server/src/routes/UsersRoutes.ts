import { FastifyInstance, RequestGenericInterface } from "fastify";
import { UserPassword } from "../data/UserPassword";
import { Auth } from "../data/Auth";
import { User } from "../common-model/User";
import { UsersData } from "../data/UsersData";
import { OTelRequestSpan } from "../OTelContext";
import { SessionStart } from "../data/AuthSession";

let usersData: UsersData;

function extractBearer(authorization: unknown): string | null {
  if (typeof authorization !== "string") return null;
  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

function applyNoStoreHeaders(res: {
  header: (k: string, v: string) => unknown;
}) {
  res.header("Cache-Control", "no-store");
  res.header("Pragma", "no-cache");
  res.header("Vary", "Authorization");
}

export class UserRoutes {
  //
  constructor(usersDataIn: UsersData) {
    usersData = usersDataIn;
  }

  public async getRoutes(fastify: FastifyInstance): Promise<void> {
    //
    fastify.get("/status/initialization", async (req, res) => {
      if ((await usersData.list(OTelRequestSpan(req))).length === 0) {
        res.status(201).send({ initialized: false });
      } else {
        res.status(201).send({ initialized: true });
      }
    });

    interface PostSession extends RequestGenericInterface {
      Body: {
        name: string;
        password: string;
      };
    }

    const refreshSession = async (req: any, res: any) => {
      applyNoStoreHeaders(res);
      const token = extractBearer(req.headers.authorization);
      if (!token) {
        return res.status(401).send({ error: "Authentication Required" });
      }
      const claims = Auth.verifyToken(token);
      if (!claims || typeof claims.user_id !== "string" || !claims.user_id) {
        return res.status(401).send({ error: "Authentication Required" });
      }
      const user = await usersData.get(OTelRequestSpan(req), claims.user_id);
      if (!user) {
        return res.status(401).send({ error: "Authentication Required" });
      }
      const now = Date.now() / 1000;
      const sessionStartedAt = SessionStart(claims) ?? now;
      if (Auth.sessionCapReached(sessionStartedAt, now)) {
        return res.status(401).send({ error: "Session Expired" });
      }
      return res.status(201).send({
        success: true,
        token: await Auth.generateJWT(user, sessionStartedAt),
      });
    };

    fastify.post("/session/refresh", refreshSession);

    fastify.post<PostSession>("/session", async (req, res) => {
      const body = req.body ?? { name: undefined, password: undefined };
      if (!body.name && !body.password && req.headers.authorization) {
        return refreshSession(req, res);
      }
      if (!body.name) {
        return res.status(400).send({ error: "Missing: Name" });
      }
      if (!body.password) {
        return res.status(400).send({ error: "Missing: Password" });
      }
      const user = await usersData.getByName(OTelRequestSpan(req), body.name);
      if (!user) {
        return res.status(403).send({ error: "Authentication Failed" });
      } else if (await UserPassword.checkPassword(OTelRequestSpan(req), user, body.password)) {
        res.status(201).send({ success: true, token: await Auth.generateJWT(user) });
      } else {
        return res.status(403).send({ error: "Authentication Failed" });
      }
    });

    fastify.get("/", async (req, res) => {
      await Auth.mustBeAuthenticated(req, res);
      const users = await usersData.list(OTelRequestSpan(req));
      for (const user of users) {
        delete user.passwordEncrypted;
      }
      res.status(201).send({ users });
    });

    interface PostUser extends RequestGenericInterface {
      Body: {
        name: string;
        password: string;
      };
    }
    fastify.post<PostUser>("/", async (req, res) => {
      let isInitialized = true;
      if ((await usersData.list(OTelRequestSpan(req))).length === 0) {
        isInitialized = false;
      }
      const userSession = await Auth.getUserSession(req);
      if (isInitialized && !userSession.isAuthenticated) {
        return res.status(403).send({ error: "Access Denied" });
      }
      const newUser = new User();
      if (!req.body.name) {
        return res.status(400).send({ error: "Missing: Name" });
      }
      if (!req.body.password) {
        return res.status(400).send({ error: "Missing: Password" });
      }
      if (await usersData.getByName(OTelRequestSpan(req), req.body.name)) {
        return res.status(400).send({ error: "Username Already Exists" });
      }
      newUser.name = req.body.name;
      await UserPassword.setPassword(OTelRequestSpan(req), newUser, req.body.password);
      await usersData.add(OTelRequestSpan(req), newUser);
      res.status(201).send({});
    });
  }
}
