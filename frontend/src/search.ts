// The Search service: ranked thread lookup over the local store. The command
// palette's only source of results.
//
// It is deliberately a service rather than a pure function over the loaded
// rows, because the stages that come next are not pure: an embedding lookup
// for semantic recall, and an AI pass that reads bodies to answer "the
// invoice from the landlord" style queries. Both need a Context (a model
// client, an index handle) and both are asynchronous, so the seam and the
// async result plumbing exist now, with one honest lexical strategy behind
// them, rather than being retrofitted around a synchronous call site.
//
// Today: one SQL pass over the thread metadata columns.
// Next:  a body stage (FTS5 over message_bodies), then a vector stage whose
//        similarity blends into the same `score` space, then a rerank.

import { Context, Effect, Layer, Schema as S } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { SqlLive } from "./sql";
import { THREAD_ROW_COLUMNS, ThreadRow, decodeThreadRows } from "./sync";

// A scored result. `score` is the blend point: every future strategy
// contributes into this one number so the caller never learns which stage
// found a thread, only how well it matched.
export const SearchHit = S.Struct({
  thread: ThreadRow,
  score: S.Number,
});
export type SearchHit = typeof SearchHit.Type;

export const SearchRequest = S.Struct({
  text: S.String,
  limit: S.Number,
});
export type SearchRequest = typeof SearchRequest.Type;

// Lexical relevance tiers. Named rather than inline so the vector stage has
// something explicit to normalise against when it starts contributing.
const SCORE_SUBJECT_PREFIX = 4;
const SCORE_SUBJECT = 3;
const SCORE_SENDER = 2;
const SCORE_SNIPPET = 1;
// The score given to every row when there is no query — an empty palette
// lists the newest threads, and "newest" is the whole ranking.
const SCORE_RECENT = 0;

// LIKE treats % and _ as wildcards, so a query containing them would match
// far more than the user typed. Escaped against an explicit ESCAPE clause.
const likePattern = (text: string, kind: "prefix" | "anywhere"): string => {
  const escaped = text.replace(/[\\%_]/g, (char) => `\\${char}`);
  return kind === "prefix" ? `${escaped}%` : `%${escaped}%`;
};

const DbHitRow = S.Struct({ score: S.Number });
const decodeScores = S.decodeUnknownEffect(S.Array(DbHitRow));

export class Search extends Context.Service<Search>()("parcel/Search", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Ranking happens in SQL: the store is the only thing that knows the
    // whole corpus, and pulling every row into JS to sort it is what the
    // service exists to avoid once the corpus stops fitting in memory.
    const search = (
      request: SearchRequest,
    ): Effect.Effect<ReadonlyArray<SearchHit>, SqlError> =>
      Effect.gen(function* () {
        const text = request.text.trim().toLowerCase();

        if (text === "") {
          const raw = yield* sql`
            SELECT ${sql.literal(THREAD_ROW_COLUMNS)}, ${SCORE_RECENT} AS score
            FROM threads
            ORDER BY latest_date DESC
            LIMIT ${request.limit}
          `;
          const threads = yield* decodeThreadRows(raw);
          return threads.map((thread) => ({ thread, score: SCORE_RECENT }));
        }

        const prefix = likePattern(text, "prefix");
        const anywhere = likePattern(text, "anywhere");

        // One scan, one CASE: the tier a row lands in is the first clause it
        // satisfies, so a subject prefix always outranks a snippet hit.
        const raw = yield* sql`
          SELECT ${sql.literal(THREAD_ROW_COLUMNS)},
            CASE
              WHEN lower(subject) LIKE ${prefix} ESCAPE '\\' THEN ${SCORE_SUBJECT_PREFIX}
              WHEN lower(subject) LIKE ${anywhere} ESCAPE '\\' THEN ${SCORE_SUBJECT}
              WHEN lower(participants) LIKE ${anywhere} ESCAPE '\\' THEN ${SCORE_SENDER}
              ELSE ${SCORE_SNIPPET}
            END AS score
          FROM threads
          WHERE lower(subject) LIKE ${anywhere} ESCAPE '\\'
             OR lower(participants) LIKE ${anywhere} ESCAPE '\\'
             OR lower(snippet) LIKE ${anywhere} ESCAPE '\\'
          ORDER BY score DESC, latest_date DESC
          LIMIT ${request.limit}
        `;

        // Two decodes over the same rows rather than one wider schema: the
        // thread shape stays shared with the inbox list, and the score is
        // this module's own column.
        const threads = yield* decodeThreadRows(raw);
        const scores = yield* decodeScores(raw).pipe(Effect.orDie);
        return threads.map((thread, index) => ({
          thread,
          score: scores[index]?.score ?? SCORE_SNIPPET,
        }));
      });

    return { search } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(SqlLive),
  );
}

export type SearchError = SqlError;
