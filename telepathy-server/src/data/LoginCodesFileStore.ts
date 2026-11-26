import type { Span } from "@opentelemetry/api";
import * as fs from "fs-extra";
import {
  LoginCodeApproveInput,
  LoginCodeAttemptInput,
  LoginCodeCancelInput,
  LoginCodeCleanupInput,
  LoginCodeConsumeInput,
  LoginCodeCreateInput,
  LoginCodeCreateResult,
  LoginCodeMarkInput,
  LoginCodeRecord,
  LoginCodeRotateInput,
  LoginCodesStore,
} from "@devopsplaybook.io/common-utils/users/login-codes";
import { Config } from "../Config";
import { FileDBUtils } from "./FileDbUtils";

const COLLECTION = "login-codes";

/**
 * Serialises every load -> compare -> save -> verify window for one file
 * collection. The mutating routes must never interleave on the same file.
 */
class CollectionMutex {
  private tail: Promise<unknown> = Promise.resolve();

  public run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const mutexes = new Map<string, CollectionMutex>();

function mutexFor(collection: string): CollectionMutex {
  let mutex = mutexes.get(collection);
  if (!mutex) {
    mutex = new CollectionMutex();
    mutexes.set(collection, mutex);
  }
  return mutex;
}

function cloneRecord(row: LoginCodeRecord): LoginCodeRecord {
  return JSON.parse(JSON.stringify(row)) as LoginCodeRecord;
}

/**
 * {@link LoginCodesStore} over the app's file-backed JSON collections.
 *
 * The server runs as a single Node process (pm2 `server`, one pod with
 * `strategy: Recreate`), so an in-process async mutex around every
 * load -> change -> save -> re-read window gives exactly-once transitions.
 * Adding replicas would require a cross-process atomic store instead.
 *
 * `FileDBUtils.load()` rewrites the collection on every call and
 * `FileDBUtils.save()` writes the redundancy copies, so reads run under the
 * same mutex. A write that cannot be verified on re-read fails closed.
 */
export class LoginCodesFileStore implements LoginCodesStore {
  private readonly mutex = mutexFor(COLLECTION);

  public constructor(private readonly config: Config) {}

  /**
   * Non-writing probe: the data directory must be writable and every existing
   * redundancy copy must parse to an array. A missing collection is created
   * lazily by the first write, so it is reported as available.
   */
  public async available(): Promise<boolean> {
    try {
      await fs.access(this.config.DATA_DIR, fs.constants.W_OK);
    } catch {
      return false;
    }
    for (let copy = 0; copy < Math.max(this.config.FILE_REDUNDANCY, 1); copy++) {
      const file = this.collectionFile(copy);
      if (!(await fs.pathExists(file))) continue;
      try {
        const content = await fs.readJSON(file);
        return Array.isArray(content);
      } catch {
        return false;
      }
    }
    return true;
  }

  public async create(
    input: LoginCodeCreateInput,
    context?: Span
  ): Promise<LoginCodeCreateResult> {
    return this.mutex.run(async () => {
      const rows = await this.readRows(context);
      if (
        rows.some(
          (row) =>
            row.requestTokenHash === input.requestTokenHash ||
            row.codeHash === input.codeHash
        )
      ) {
        return { ok: false, reason: "conflict" };
      }
      if (
        rows.filter((row) => row.status === "pending").length >= input.maxPending
      ) {
        return { ok: false, reason: "pending_cap" };
      }

      const row: LoginCodeRecord = {
        id: input.id,
        requestTokenHash: input.requestTokenHash,
        codeHash: input.codeHash,
        previousCodeHash: null,
        codeExpiresAt: input.codeExpiresAt,
        previousCodeExpiresAt: null,
        status: "pending",
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        expiresAt: input.expiresAt,
        approvedAt: null,
        approvedByUserId: null,
        consumedAt: null,
        attempts: 0,
        requestUserAgent: input.requestUserAgent,
      };
      rows.push(row);
      await this.writeRows(rows, context);

      const stored = (await this.readRows(context)).find(
        (candidate) => candidate.id === row.id
      );
      if (
        !stored ||
        stored.status !== "pending" ||
        stored.requestTokenHash !== input.requestTokenHash
      ) {
        return { ok: false, reason: "conflict" };
      }
      return { ok: true };
    });
  }

  public async getByRequestTokenHash(
    requestTokenHash: string,
    context?: Span
  ): Promise<LoginCodeRecord | null> {
    return this.mutex.run(async () => {
      const rows = await this.readRows(context);
      const row = rows.find(
        (candidate) => candidate.requestTokenHash === requestTokenHash
      );
      return row ? cloneRecord(row) : null;
    });
  }

  public async getByCodeHash(
    codeHash: string,
    context?: Span
  ): Promise<LoginCodeRecord | null> {
    return this.mutex.run(async () => {
      const rows = await this.readRows(context);
      const current = rows.find((candidate) => candidate.codeHash === codeHash);
      if (current) return cloneRecord(current);
      // The routes enforce the grace window on the previous hash.
      const previous = rows.find(
        (candidate) => candidate.previousCodeHash === codeHash
      );
      return previous ? cloneRecord(previous) : null;
    });
  }

  public async rotate(
    input: LoginCodeRotateInput,
    context?: Span
  ): Promise<boolean> {
    return this.mutex.run(async () => {
      const rows = await this.readRows(context);
      const row = rows.find((candidate) => candidate.id === input.id);
      if (
        !row ||
        row.status !== "pending" ||
        row.codeHash !== input.expectedCodeHash
      ) {
        return false;
      }
      row.previousCodeHash = row.codeHash;
      row.previousCodeExpiresAt = input.previousCodeExpiresAt;
      row.codeHash = input.newCodeHash;
      row.codeExpiresAt = input.codeExpiresAt;
      row.updatedAt = input.updatedAt;
      await this.writeRows(rows, context);

      const stored = (await this.readRows(context)).find(
        (candidate) => candidate.id === input.id
      );
      return (
        stored !== undefined &&
        stored.status === "pending" &&
        stored.codeHash === input.newCodeHash &&
        stored.previousCodeHash === input.expectedCodeHash &&
        stored.previousCodeExpiresAt === input.previousCodeExpiresAt &&
        stored.codeExpiresAt === input.codeExpiresAt
      );
    });
  }

  public async approve(
    input: LoginCodeApproveInput,
    context?: Span
  ): Promise<boolean> {
    return this.mutex.run(async () => {
      const rows = await this.readRows(context);
      const row = rows.find((candidate) => candidate.id === input.id);
      if (!row || row.status !== "pending") return false;

      const matchesCurrent = row.codeHash === input.submittedCodeHash;
      // ISO-8601 UTC strings compare lexically, like the SQL reference store's
      // TEXT columns.
      const matchesPrevious =
        row.previousCodeHash === input.submittedCodeHash &&
        row.previousCodeExpiresAt !== null &&
        row.previousCodeExpiresAt > input.now;
      if (!matchesCurrent && !matchesPrevious) return false;

      row.status = "approved";
      row.approvedAt = input.approvedAt;
      row.approvedByUserId = input.approvedByUserId;
      row.updatedAt = input.now;
      await this.writeRows(rows, context);

      const stored = (await this.readRows(context)).find(
        (candidate) => candidate.id === input.id
      );
      return (
        stored !== undefined &&
        stored.status === "approved" &&
        stored.approvedByUserId === input.approvedByUserId &&
        stored.approvedAt === input.approvedAt
      );
    });
  }

  public async consume(
    input: LoginCodeConsumeInput,
    context?: Span
  ): Promise<LoginCodeRecord | null> {
    return this.mutex.run(async () => {
      const rows = await this.readRows(context);
      const row = rows.find(
        (candidate) => candidate.requestTokenHash === input.requestTokenHash
      );
      if (!row || row.status !== "approved") return null;

      row.status = "consumed";
      row.consumedAt = input.consumedAt;
      row.updatedAt = input.updatedAt;
      await this.writeRows(rows, context);

      const stored = (await this.readRows(context)).find(
        (candidate) => candidate.id === row.id
      );
      if (
        !stored ||
        stored.status !== "consumed" ||
        stored.consumedAt !== input.consumedAt
      ) {
        return null;
      }
      return cloneRecord(stored);
    });
  }

  public async cancel(
    input: LoginCodeCancelInput,
    context?: Span
  ): Promise<boolean> {
    return this.transition(
      input.requestTokenHash,
      "cancelled",
      input.updatedAt,
      (row) => row.status === "pending",
      context
    );
  }

  public async markExpired(
    input: LoginCodeMarkInput,
    context?: Span
  ): Promise<boolean> {
    return this.transitionById(
      input.id,
      "expired",
      input.updatedAt,
      (row) => row.status === "pending" || row.status === "approved",
      context
    );
  }

  public async markFailed(
    input: LoginCodeMarkInput,
    context?: Span
  ): Promise<boolean> {
    return this.transitionById(
      input.id,
      "failed",
      input.updatedAt,
      (row) => row.status === "pending" || row.status === "approved",
      context
    );
  }

  public async recordAttempt(
    input: LoginCodeAttemptInput,
    context?: Span
  ): Promise<boolean> {
    return this.mutex.run(async () => {
      const rows = await this.readRows(context);
      const row = rows.find((candidate) => candidate.id === input.id);
      if (
        !row ||
        row.status !== "pending" ||
        row.attempts >= input.maxAttempts
      ) {
        return false;
      }
      const expected = row.attempts + 1;
      row.attempts = expected;
      row.updatedAt = input.updatedAt;
      await this.writeRows(rows, context);

      const stored = (await this.readRows(context)).find(
        (candidate) => candidate.id === input.id
      );
      return (
        stored !== undefined &&
        stored.status === "pending" &&
        stored.attempts === expected
      );
    });
  }

  public async cleanup(
    input: LoginCodeCleanupInput,
    context?: Span
  ): Promise<number> {
    return this.mutex.run(async () => {
      const rows = await this.readRows(context);
      const expired = rows
        .filter((row) => row.createdAt < input.olderThan)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, Math.max(input.limit, 0));
      if (expired.length === 0) return 0;

      const removed = new Set(expired.map((row) => row.id));
      const remaining = rows.filter((row) => !removed.has(row.id));
      await this.writeRows(remaining, context);

      const stored = await this.readRows(context);
      if (stored.some((row) => removed.has(row.id))) return 0;
      return removed.size;
    });
  }

  private async transition(
    requestTokenHash: string,
    status: "cancelled",
    updatedAt: string,
    allowed: (row: LoginCodeRecord) => boolean,
    context?: Span
  ): Promise<boolean> {
    return this.mutex.run(async () => {
      const rows = await this.readRows(context);
      const row = rows.find(
        (candidate) => candidate.requestTokenHash === requestTokenHash
      );
      if (!row || !allowed(row)) return false;
      row.status = status;
      row.updatedAt = updatedAt;
      await this.writeRows(rows, context);

      const stored = (await this.readRows(context)).find(
        (candidate) => candidate.requestTokenHash === requestTokenHash
      );
      return stored !== undefined && stored.status === status;
    });
  }

  private async transitionById(
    id: string,
    status: "expired" | "failed",
    updatedAt: string,
    allowed: (row: LoginCodeRecord) => boolean,
    context?: Span
  ): Promise<boolean> {
    return this.mutex.run(async () => {
      const rows = await this.readRows(context);
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || !allowed(row)) return false;
      row.status = status;
      row.updatedAt = updatedAt;
      await this.writeRows(rows, context);

      const stored = (await this.readRows(context)).find(
        (candidate) => candidate.id === id
      );
      return stored !== undefined && stored.status === status;
    });
  }

  private collectionFile(copy: number): string {
    return `${this.config.DATA_DIR}/${COLLECTION}${copy > 0 ? `.${copy}` : ""}.json`;
  }

  private async readRows(context?: Span): Promise<LoginCodeRecord[]> {
    const rows = await FileDBUtils.load(context, COLLECTION, []);
    if (!Array.isArray(rows)) {
      throw new Error("login-codes collection is not an array");
    }
    return rows;
  }

  private async writeRows(rows: LoginCodeRecord[], context?: Span): Promise<void> {
    await FileDBUtils.save(context, COLLECTION, rows);
  }
}