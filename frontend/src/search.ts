// The Search service: ranked thread lookup over the local store. The command
// palette's only source of results.
//
// A service rather than a pure function over the loaded rows, because the
// stages that come next are not pure: an embedding lookup for semantic
// recall, and an AI pass that reads bodies to answer "the invoice from the
// landlord" style queries. Both need a Context and both are asynchronous, so
// the seam and the async plumbing exist now rather than being retrofitted
// around a synchronous call site.
//
// Today: one SQL pass over the thread metadata columns. Ranking lives
// entirely in ORDER BY — the caller wants an ordered list, not scores.

import { Context, Effect, Layer, Schema as S } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { SqlLive } from "./sql";
import { THREAD_ROW_COLUMNS, ThreadRow, decodeThreadRows } from "./sync";

export const SearchRequest = S.Struct({
  text: S.String,
  limit: S.Number,
});
export type SearchRequest = typeof SearchRequest.Type;

// LIKE treats % and _ as wildcards, so a query containing them would match
// far more than the user typed. Escaped against an explicit ESCAPE clause.
const likePattern = (text: string, kind: "prefix" | "anywhere"): string => {
  const escaped = text.replace(/[\\%_]/g, (char) => `\\${char}`);
  return kind === "prefix" ? `${escaped}%` : `%${escaped}%`;
};

export class Search extends Context.Service<Search>()("parcel/Search", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const search = (
      request: SearchRequest,
    ): Effect.Effect<ReadonlyArray<ThreadRow>, SqlError> =>
      Effect.gen(function* () {
        const text = request.text.trim().toLowerCase();

        // No query, no ranking to do: the newest threads are the answer.
        if (text === "") {
          const raw = yield* sql`
            SELECT ${sql.literal(THREAD_ROW_COLUMNS)}
            FROM threads
            WHERE is_spam = 0 AND is_trash = 0
            ORDER BY latest_date DESC
            LIMIT ${request.limit}
          `;
          return yield* decodeThreadRows(raw);
        }

        const prefix = likePattern(text, "prefix");
        const anywhere = likePattern(text, "anywhere");

        // The CASE is the ranking: a row sorts by the first clause it
        // satisfies, so a subject prefix beats a subject match beats a
        // sender match beats a snippet-only match, then newest first.
        const raw = yield* sql`
          SELECT ${sql.literal(THREAD_ROW_COLUMNS)}
          FROM threads
          WHERE is_spam = 0 AND is_trash = 0
            AND (lower(subject) LIKE ${anywhere} ESCAPE '\\'
              OR lower(participants) LIKE ${anywhere} ESCAPE '\\'
              OR lower(snippet) LIKE ${anywhere} ESCAPE '\\')
          ORDER BY
            CASE
              WHEN lower(subject) LIKE ${prefix} ESCAPE '\\' THEN 4
              WHEN lower(subject) LIKE ${anywhere} ESCAPE '\\' THEN 3
              WHEN lower(participants) LIKE ${anywhere} ESCAPE '\\' THEN 2
              ELSE 1
            END DESC,
            latest_date DESC
          LIMIT ${request.limit}
        `;
        return yield* decodeThreadRows(raw);
      });

    return { search } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(SqlLive),
  );
}

export type SearchError = SqlError;
