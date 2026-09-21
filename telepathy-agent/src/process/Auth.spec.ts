import { Auth } from "./Auth";

test("get token if not empty", async () => {
  await Auth.getAuthHeader(null);
});
