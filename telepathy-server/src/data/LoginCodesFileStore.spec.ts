jest.mock("../OTelContext", () => {
  const span = { end: () => undefined };
  return {
    OTelLogger: () => ({
      createModuleLogger: () => ({
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      }),
    }),
    OTelTracer: () => ({ startSpan: () => span }),
    OTelRequestSpan: () => span,
    OTelSetTracer: () => undefined,
    OTelSetMeter: () => undefined,
    OTelMeter: () => undefined,
  };
});

import { registerLoginCodesStoreConformance } from "@devopsplaybook.io/common-utils/users/login-codes/testing";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { Config } from "../Config";
import { FileDBUtils } from "../data/FileDbUtils";
import { LoginCodesFileStore } from "./LoginCodesFileStore";

jest.setTimeout(60000);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "telepathy-login-codes-"));
const config = {
  DATA_DIR: tempDir,
  FILE_REDUNDANCY: 1,
} as unknown as Config;
FileDBUtils.init(config);

afterAll(() => {
  fs.removeSync(tempDir);
});

registerLoginCodesStoreConformance(
  { describe, it },
  { createStore: () => new LoginCodesFileStore(config) }
);

function futureIso(): string {
  return new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 10).toISOString();
}

function makeInput(id: string) {
  const now = new Date();
  return {
    id,
    requestTokenHash: `request-token-${id}`,
    codeHash: `code-${id}`,
    codeExpiresAt: new Date(now.getTime() + 30000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300000).toISOString(),
    requestUserAgent: "telepathy-store-spec",
    maxPending: 1000,
  };
}

describe("LoginCodesFileStore single-use semantics", () => {
  it("redeems an approved request exactly once under concurrent consumes", async () => {
    const store = new LoginCodesFileStore(config);
    await store.cleanup({ olderThan: futureIso(), limit: 1000000 });

    const input = makeInput("race-consume");
    expect(await store.create(input)).toEqual({ ok: true });
    const now = new Date().toISOString();
    expect(
      await store.approve({
        id: input.id,
        submittedCodeHash: input.codeHash,
        now,
        approvedByUserId: "user-1",
        approvedAt: now,
      })
    ).toBe(true);

    const results = await Promise.all([
      store.consume({
        requestTokenHash: input.requestTokenHash,
        consumedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      store.consume({
        requestTokenHash: input.requestTokenHash,
        consumedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ]);

    expect(results.filter((row) => row !== null)).toHaveLength(1);
    await store.cleanup({ olderThan: futureIso(), limit: 1000000 });
  });

  it("fails closed when the storage write is lost", async () => {
    const store = new LoginCodesFileStore(config);
    await store.cleanup({ olderThan: futureIso(), limit: 1000000 });

    const input = makeInput("lost-write");
    expect(await store.create(input)).toEqual({ ok: true });

    // Drop the mutation write but keep the read-back: the CAS can no longer be
    // verified, so the store must report failure instead of success.
    const originalSave = FileDBUtils.save;
    let saves = 0;
    const spy = jest
      .spyOn(FileDBUtils, "save")
      .mockImplementation(async (context, collection, content) => {
        saves += 1;
        if (saves === 2) return;
        await originalSave.call(FileDBUtils, context, collection, content);
      });
    try {
      const cancelled = await store.cancel({
        requestTokenHash: input.requestTokenHash,
        updatedAt: new Date().toISOString(),
      });
      expect(cancelled).toBe(false);
    } finally {
      spy.mockRestore();
    }

    const row = await store.getByRequestTokenHash(input.requestTokenHash);
    expect(row?.status).toBe("pending");
    await store.cleanup({ olderThan: futureIso(), limit: 1000000 });
  });
});