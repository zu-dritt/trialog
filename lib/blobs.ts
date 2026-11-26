// Where the bytes of an attachment live. This is the only file that reads or writes them.
//
// Today they sit in the `data` column of the `attachments` table (Postgres `bytea`), or in a Map
// for the in-memory store. Everything else about an attachment (who uploaded it, its size, which
// message it belongs to) is handled by lib/store.ts, which only ever calls put, get and delete.
// Moving the bytes somewhere else later, for example to a private object store, means writing one
// more implementation of `Blobs` here and choosing it in getStore(). Whatever is chosen must stay
// private: bytes are only ever handed out by GET /api/attachments/<id>, behind the Bearer token.
import { MAX_ATTACHMENT_BYTES } from './core';

/** The part of a database connection this module needs. lib/store.ts passes its own. */
export interface BlobQueryable {
  query(text: string, params: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface Blobs {
  /**
   * Stores the bytes of an attachment. The store calls this inside the transaction that has just
   * inserted the attachment's row, and passes that transaction as `q`.
   */
  put(q: BlobQueryable, id: string, bytes: Buffer): Promise<void>;
  /** The bytes, or null when there are none. */
  get(q: BlobQueryable, id: string): Promise<Buffer | null>;
  /** Called after the rows of these attachments were deleted. Must not fail when an id is unknown. */
  delete(q: BlobQueryable, ids: string[]): Promise<void>;
}

/** The 4 MB cap holds on every storage path, whoever the caller is. */
function checkSize(bytes: Buffer): void {
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`An attachment must be between 1 byte and ${MAX_ATTACHMENT_BYTES} bytes, got ${bytes.length}.`);
  }
}

/** Bytes in the `data` column of the attachment's own row. */
export function createSqlBlobs(): Blobs {
  return {
    async put(q, id, bytes) {
      checkSize(bytes);
      await q.query(`UPDATE attachments SET data = $2::bytea WHERE id = $1::text`, [id, bytes]);
    },
    async get(q, id) {
      const [row] = await q.query(`SELECT data FROM attachments WHERE id = $1::text`, [id]);
      const data = row?.data as Uint8Array | null | undefined;
      return data ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
    },
    // Deleting the row deleted the bytes with it.
    async delete() {},
  };
}

/** Bytes in memory, for the store without a database (local development and tests). */
export function createMemoryBlobs(): Blobs {
  const map = new Map<string, Buffer>();
  return {
    async put(_q, id, bytes) {
      checkSize(bytes);
      map.set(id, Buffer.from(bytes));
    },
    async get(_q, id) {
      const bytes = map.get(id);
      return bytes ? Buffer.from(bytes) : null;
    },
    async delete(_q, ids) {
      for (const id of ids) map.delete(id);
    },
  };
}
