// The corpus: real mail, out of the real local store.
//
// Hillclimbing a converter on synthetic fixtures teaches you to convert
// synthetic fixtures. The interesting cases are the ones nobody would think to
// write — a retailer's eight-deep nested layout tables, a calendar invite
// rendered as a table of tables, a reply chain that has been through four
// clients — and they're all sitting in the app's own SQLite store.
//
// Getting at that store is already solved: `bun run sql` copies the OPFS
// database out of the Chrome profile to /tmp/parcel.sqlite.snapshot (see
// perf/src/sql.ts). This module only reads what that produced, so there is one
// copy of the extraction logic and it lives with the tool that owns it.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export const SNAPSHOT_PATH = "/tmp/parcel.sqlite.snapshot";

export type Summary = Readonly<{
  messageId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  date: number;
}>;

export type Body = Readonly<{
  mimeType: string;
  html: string;
}>;

export type Asset = Readonly<{
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
}>;

type MessageRow = {
  id: string;
  subject: string;
  from_name: string;
  from_email: string;
  internal_date: number;
};

type BodyRow = {
  mime_type: string;
  data: Uint8Array<ArrayBuffer>;
  codec: string;
};
type AssetRow = { mime_type: string; bytes: Uint8Array<ArrayBuffer> };

export const open = (): Database => {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.error(
      `No snapshot at ${SNAPSHOT_PATH}. Run \`bun run sql --refresh\` first — ` +
        "it extracts the app's OPFS database out of the Chrome profile.",
    );
    process.exit(1);
  }
  return new Database(SNAPSHOT_PATH, { readonly: true });
};

export class Corpus {
  constructor(private readonly db: Database) {}

  /** Newest first, html bodies only — a plain-text mail has nothing to
   *  convert and would only dilute the list. */
  list(limit: number, offset: number, query: string): ReadonlyArray<Summary> {
    const filtered = query.trim() !== "";
    const rows = this.db
      .query(
        `SELECT m.id, m.subject, m.from_name, m.from_email, m.internal_date
         FROM messages m
         JOIN message_bodies b ON b.message_id = m.id
         WHERE b.mime_type LIKE 'text/html%'
         ${filtered ? "AND (m.subject LIKE ?1 OR m.from_name LIKE ?1 OR m.from_email LIKE ?1)" : ""}
         ORDER BY m.internal_date DESC
         LIMIT ${filtered ? "?2" : "?1"} OFFSET ${filtered ? "?3" : "?2"}`,
      )
      .all(
        ...(filtered ? [`%${query.trim()}%`, limit, offset] : [limit, offset]),
      ) as Array<MessageRow>;

    return rows.map((row) => ({
      messageId: row.id,
      subject: row.subject,
      fromName: row.from_name,
      fromEmail: row.from_email,
      date: row.internal_date,
    }));
  }

  body(messageId: string): Body | undefined {
    const row = this.db
      .query(
        "SELECT mime_type, data, codec FROM message_bodies WHERE message_id = ?",
      )
      .get(messageId) as BodyRow | null;
    if (row === null) return undefined;

    // The codec is stored per row, so bodies written before compression
    // existed and bodies too short to be worth compressing both read back
    // through this one path. Matches frontend/src/compression.ts.
    const bytes =
      row.codec === "gzip"
        ? Bun.gunzipSync(row.data)
        : new Uint8Array(row.data);
    return { mimeType: row.mime_type, html: new TextDecoder().decode(bytes) };
  }

  subject(messageId: string): string {
    const row = this.db
      .query("SELECT subject FROM messages WHERE id = ?")
      .get(messageId) as { subject: string } | null;
    return row?.subject ?? "";
  }

  /** Urls the app has already cached bytes for. The dashboard rewrites these
   *  to its own endpoint so both panes show the same pictures the app would,
   *  without either of them touching the sender's servers. */
  imageUrls(messageId: string): ReadonlyArray<string> {
    return (
      this.db
        .query("SELECT url FROM message_images WHERE message_id = ?")
        .all(messageId) as Array<{ url: string }>
    ).map((row) => row.url);
  }

  contentIds(messageId: string): ReadonlyArray<string> {
    return (
      this.db
        .query(
          "SELECT content_id FROM message_attachments WHERE message_id = ?",
        )
        .all(messageId) as Array<{ content_id: string }>
    ).map((row) => row.content_id);
  }

  /** Bytes for one image, by url or by `cid:` reference. */
  asset(messageId: string, src: string): Asset | undefined {
    const cid = src.startsWith("cid:")
      ? src.slice(4).replace(/^<|>$/g, "")
      : undefined;

    const row = (
      cid === undefined
        ? this.db
            .query(
              "SELECT mime_type, bytes FROM message_images WHERE message_id = ? AND url = ?",
            )
            .get(messageId, src)
        : this.db
            .query(
              "SELECT mime_type, bytes FROM message_attachments WHERE message_id = ? AND content_id = ?",
            )
            .get(messageId, cid)
    ) as AssetRow | null;

    return row === null
      ? undefined
      : { mimeType: row.mime_type, bytes: new Uint8Array(row.bytes) };
  }
}
