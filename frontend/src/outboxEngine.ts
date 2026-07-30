// The OutboxEngine: local writes first, Gmail when it can.
//
// Every outgoing action — archive, star, mark read, send — is enqueued as a
// durable row and applied to the local store in the same transaction. The
// action is therefore *done* as far as the UI is concerned before any request
// is made, and survives a reload, a tunnel, or a closed tab. Draining is best
// effort: outboxMachine.ts decides when, this decides what happens.
//
// Convergence is the sync's job, not this file's. A label edit that lands is
// re-read from Gmail by the next history pass and agrees; one that is
// permanently rejected is rolled back locally and the same pass confirms the
// rollback. See the pending-op re-apply in sync.ts, which is what stops a
// history pass from painting server state over an op that has not gone out.

import {
  Array as Arr,
  Clock,
  Context,
  Effect,
  Layer,
  Match as M,
  Option,
  Schema as S,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { ts } from "foldkit/schema";

import { Gmail, ThreadId, type GmailError } from "./Gmail";
import { buildRfc2822, toRawMessage } from "./mime";
import {
  MAX_ATTEMPTS,
  MODIFY_THREAD_LABELS,
  OutboxOp,
  SendMessage,
  ThreadPatch,
  classifyFailure,
  decodeOutboxPayload,
  encodeOutboxOp,
  exhaustedFailure,
  inverseOf,
  patchOf,
} from "./outboxOps";
import { SqlLive } from "./sql";

// RESULTS

/** How much is still queued, and how much will never go. Rides on every
 *  drain result so the toolbar can report the queue without a second read. */
export const OutboxSummary = S.Struct({
  pendingCount: S.Number,
  failedCount: S.Number,
});
export type OutboxSummary = typeof OutboxSummary.Type;

export const emptySummary: OutboxSummary = { pendingCount: 0, failedCount: 0 };

/** The op reached Gmail. `maybeSentThreadId` is Some when what landed was a
 *  reply, which is the page's cue to drop that thread's "sending" chip. */
export const Applied = ts("Applied", {
  maybeSentThreadId: S.Option(ThreadId),
  summary: OutboxSummary,
});

/** Nothing left to send. */
export const Drained = ts("Drained", { summary: OutboxSummary });
/** Not this time. The op is untouched and stays at the head of the queue.
 *  NOTE: No summary, unlike its siblings: nothing left the queue, so the
 *  caller's count is still correct and a COUNT here would be asking a
 *  question whose answer we already have. */
export const Deferred = ts("Deferred", {
  isAuthError: S.Boolean,
  maybeRetryAfterMs: S.Option(S.Number),
});
/** The op will never succeed. A label edit has already been rolled back —
 *  `maybeRollback` is the patch the model applies to match — and a send has
 *  been kept as a failed draft. */
export const Rejected = ts("Rejected", {
  maybeRollback: S.Option(ThreadPatch),
  /** Same meaning as on {@link Applied}: the reply whose "sending" chip this
   *  settles, one way or the other. */
  maybeSentThreadId: S.Option(ThreadId),
  message: S.String,
  summary: OutboxSummary,
});

export const DrainResult = S.Union([Applied, Drained, Deferred, Rejected]);
export type DrainResult = typeof DrainResult.Type;

// ROWS

const DbOutboxRow = S.Struct({
  id: S.Number,
  payload: S.String,
  attempts: S.Number,
});
const decodeDbOutboxRows = S.decodeUnknownEffect(S.Array(DbOutboxRow));

const DbSummaryRow = S.Struct({ pending: S.Number, failed: S.Number });
const decodeDbSummaries = S.decodeUnknownEffect(S.Array(DbSummaryRow));

const DbAccountRow = S.Struct({ email: S.NullOr(S.String) });
const decodeDbAccounts = S.decodeUnknownEffect(S.Array(DbAccountRow));

const DbPayloadRow = S.Struct({ payload: S.String });
const decodeDbPayloads = S.decodeUnknownEffect(S.Array(DbPayloadRow));

const PENDING = "pending";
const FAILED = "failed";

// SERVICE

export class OutboxEngine extends Context.Service<OutboxEngine>()(
  "parcel/OutboxEngine",
  {
    make: Effect.gen(function* () {
      const gmail = yield* Gmail;
      const sql = yield* SqlClient.SqlClient;

      // The local half of a label edit: at most three single-row updates on
      // the primary key, one per column the op actually speaks to.
      const applyPatchLocal = (patch: ThreadPatch) =>
        Effect.all(
          [
            ...Arr.fromOption(
              Option.map(
                patch.maybeIsUnread,
                (isUnread) =>
                  sql`UPDATE threads SET is_unread = ${isUnread ? 1 : 0} WHERE id = ${patch.threadId}`,
              ),
            ),
            ...Arr.fromOption(
              Option.map(
                patch.maybeIsStarred,
                (isStarred) =>
                  sql`UPDATE threads SET is_starred = ${isStarred ? 1 : 0} WHERE id = ${patch.threadId}`,
              ),
            ),
            ...Arr.fromOption(
              Option.liftPredicate(
                sql`UPDATE threads SET in_inbox = 0 WHERE id = ${patch.threadId}`,
                () => patch.isRemoved,
              ),
            ),
          ],
          { discard: true },
        );

      /**
       * Re-applies every queued label edit, oldest first.
       *
       * Called by the sync inside its own write transaction: a history pass
       * writes the mailbox as Gmail currently sees it, which is a mailbox
       * where these ops have not happened yet. Without this, archiving a
       * thread and then catching up would put it straight back in the list
       * until the op drained.
       */
      const reapplyPendingLabelOps: Effect.Effect<void, SqlError> = Effect.gen(
        function* () {
          const raw = yield* sql`
            SELECT payload FROM outbox
            WHERE status = ${PENDING} AND kind = ${MODIFY_THREAD_LABELS}
            ORDER BY id ASC
          `;
          const rows = yield* decodeDbPayloads(raw).pipe(Effect.orDie);
          yield* Effect.forEach(
            rows,
            (row) =>
              decodeOutboxPayload(row.payload).pipe(
                Effect.flatMap((maybeOp) =>
                  Option.match(maybeOp, {
                    onNone: () => Effect.void,
                    onSome: (op) =>
                      M.value(op).pipe(
                        M.withReturnType<Effect.Effect<void, SqlError>>(),
                        M.tagsExhaustive({
                          ModifyThreadLabels: (labels) =>
                            applyPatchLocal(patchOf(labels)),
                          // Filtered out by the query above; matched here
                          // anyway so a third op kind cannot slip through.
                          SendMessage: () => Effect.void,
                        }),
                      ),
                  }),
                ),
              ),
            { discard: true },
          );
        },
      );

      const summary: Effect.Effect<OutboxSummary, SqlError> = Effect.gen(
        function* () {
          const raw = yield* sql`
            SELECT
              (SELECT COUNT(*) FROM outbox WHERE status = ${PENDING}) AS pending,
              (SELECT COUNT(*) FROM outbox WHERE status = ${FAILED}) AS failed
          `;
          const rows = yield* decodeDbSummaries(raw).pipe(Effect.orDie);
          return Option.match(Arr.head(rows), {
            onNone: () => emptySummary,
            onSome: (row) => ({
              pendingCount: row.pending,
              failedCount: row.failed,
            }),
          });
        },
      );

      const withSummary = <Result>(
        toResult: (summary: OutboxSummary) => Result,
      ): Effect.Effect<Result, SqlError> => Effect.map(summary, toResult);

      /**
       * Queue an op and apply it locally, in one transaction: the UI is told
       * the action happened, so the record that it still has to happen must
       * not be able to go missing.
       *
       * The returned patch is what the model applies to the one row involved.
       * A send changes no thread rows, hence `None`.
       */
      const enqueue = (
        op: OutboxOp,
      ): Effect.Effect<Option.Option<ThreadPatch>, SqlError> =>
        Effect.gen(function* () {
          const createdAt = yield* Clock.currentTimeMillis;
          const maybePatch = M.value(op).pipe(
            M.withReturnType<Option.Option<ThreadPatch>>(),
            M.tagsExhaustive({
              ModifyThreadLabels: (labels) => Option.some(patchOf(labels)),
              SendMessage: () => Option.none(),
            }),
          );
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO outbox ${sql.insert([
                {
                  kind: op._tag,
                  payload: JSON.stringify(encodeOutboxOp(op)),
                  created_at: createdAt,
                  attempts: 0,
                  status: PENDING,
                  last_error: "",
                },
              ])}`;
              yield* Option.match(maybePatch, {
                onNone: () => Effect.void,
                onSome: applyPatchLocal,
              });
            }),
          );
          return maybePatch;
        });

      // The signed-in address, which is the From of anything we send. It is
      // already in the store as the mailbox's owner, so sending needs no
      // extra plumbing to learn who is sending.
      const accountEmail = Effect.gen(function* () {
        const raw = yield* sql`SELECT email FROM sync_state WHERE id = 1`;
        const rows = yield* decodeDbAccounts(raw).pipe(Effect.orDie);
        return Option.flatMap(Arr.head(rows), (row) =>
          Option.fromNullishOr(row.email),
        );
      });

      const send = (
        op: SendMessage,
      ): Effect.Effect<void, GmailError | SqlError> =>
        Effect.gen(function* () {
          const maybeFrom = yield* accountEmail;
          const boundary = yield* Effect.sync(
            () => `parcel-${crypto.randomUUID()}`,
          );
          const raw = toRawMessage(
            buildRfc2822({
              // NOTE: An empty From is valid here: Gmail fills in the
              // authenticated account, which is the address the store would
              // have given anyway.
              from: Option.getOrElse(maybeFrom, () => ""),
              to: op.to,
              subject: op.subject,
              bodyMarkdown: op.bodyMarkdown,
              bodyHtml: op.bodyHtml,
              maybeInReplyTo: op.maybeInReplyTo,
              references: op.references,
              boundary,
            }),
          );
          yield* Option.match(op.maybeThreadId, {
            onNone: () => gmail.sendRaw(raw),
            onSome: (threadId) => gmail.sendRaw(raw, threadId),
          });
        });

      const execute = (
        op: OutboxOp,
      ): Effect.Effect<void, GmailError | SqlError> =>
        M.value(op).pipe(
          M.withReturnType<Effect.Effect<void, GmailError | SqlError>>(),
          M.tagsExhaustive({
            ModifyThreadLabels: ({ threadId, addLabelIds, removeLabelIds }) =>
              Effect.asVoid(
                gmail.modifyThread(threadId, { addLabelIds, removeLabelIds }),
              ),
            SendMessage: send,
          }),
        );

      const complete = (id: number, op: OutboxOp) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM outbox WHERE id = ${id}`;
          const maybeSentThreadId = M.value(op).pipe(
            M.withReturnType<Option.Option<ThreadId>>(),
            M.tagsExhaustive({
              SendMessage: ({ maybeThreadId }) => maybeThreadId,
              ModifyThreadLabels: () => Option.none(),
            }),
          );
          return yield* withSummary((summary) =>
            Applied({ maybeSentThreadId, summary }),
          );
        });

      // A failed send keeps its body so the user can try again; a failed label
      // edit is undone locally and forgotten, because the truth is one history
      // pass away and a queue of dead flag flips helps nobody.
      const reject = (id: number, op: OutboxOp, message: string) =>
        M.value(op).pipe(
          M.withReturnType<Effect.Effect<DrainResult, SqlError>>(),
          M.tagsExhaustive({
            ModifyThreadLabels: (labels) =>
              Effect.gen(function* () {
                const rollback = patchOf(inverseOf(labels));
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* applyPatchLocal(rollback);
                    yield* sql`DELETE FROM outbox WHERE id = ${id}`;
                  }),
                );
                return yield* withSummary((summary) =>
                  Rejected({
                    maybeRollback: Option.some(rollback),
                    maybeSentThreadId: Option.none(),
                    message,
                    summary,
                  }),
                );
              }),
            SendMessage: (sendMessage) =>
              Effect.gen(function* () {
                yield* sql`
                  UPDATE outbox SET status = ${FAILED}, last_error = ${message}
                  WHERE id = ${id}
                `;
                return yield* withSummary((summary) =>
                  Rejected({
                    maybeRollback: Option.none(),
                    maybeSentThreadId: sendMessage.maybeThreadId,
                    message,
                    summary,
                  }),
                );
              }),
          }),
        );

      const defer = (
        id: number,
        attempts: number,
        maybeRetryAfterMs: Option.Option<number>,
        message: string,
      ) =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE outbox SET attempts = ${attempts + 1}, last_error = ${message}
            WHERE id = ${id}
          `;
          return Deferred({ isAuthError: false, maybeRetryAfterMs });
        });

      // NOTE: Attempts are not bumped. The grant coming back is not a retry of
      // a failing request, and counting it as one would let a long
      // disconnection burn a send's whole attempt budget without it ever
      // having been refused on its merits.
      const park = Effect.succeed(
        Deferred({ isAuthError: true, maybeRetryAfterMs: Option.none() }),
      );

      const attempt = (id: number, attempts: number, op: OutboxOp) =>
        execute(op).pipe(
          Effect.flatMap(() => complete(id, op)),
          Effect.catch((error) => {
            const failure = classifyFailure(error);
            // The cap turns a long run of transient failures into a settled
            // answer, so one unsendable op cannot hold the queue behind it.
            const capped =
              failure._tag === "Transient" && attempts + 1 >= MAX_ATTEMPTS
                ? exhaustedFailure(attempts + 1)
                : failure;
            return M.value(capped).pipe(
              M.withReturnType<Effect.Effect<DrainResult, SqlError>>(),
              M.tagsExhaustive({
                Unauthorized: () => park,
                Transient: ({ maybeRetryAfterMs }) =>
                  defer(id, attempts, maybeRetryAfterMs, String(error)),
                Permanent: ({ message }) => reject(id, op, message),
              }),
            );
          }),
        );

      /**
       * One turn of the drain: the oldest queued op, executed once.
       *
       * Strictly one at a time, oldest first. Two label edits on the same
       * thread only compose in the order they were made, and a global FIFO is
       * the cheapest thing that guarantees it.
       *
       * NOTE: No cross-tab lease, because there is never a second drainer to
       * race with: OPFS access handles are exclusive, so a second tab cannot
       * open this database at all (see sql.ts).
       */
      const drainStep: Effect.Effect<DrainResult, SqlError> = Effect.gen(
        function* () {
          const raw = yield* sql`
            SELECT id, payload, attempts FROM outbox
            WHERE status = ${PENDING}
            ORDER BY id ASC
            LIMIT 1
          `;
          const rows = yield* decodeDbOutboxRows(raw).pipe(Effect.orDie);
          const maybeRow = Arr.head(rows);
          if (Option.isNone(maybeRow)) {
            return yield* withSummary((summary) => Drained({ summary }));
          }
          const row = maybeRow.value;
          const maybeOp = yield* decodeOutboxPayload(row.payload);

          return yield* Option.match(maybeOp, {
            // Unreadable, so unexecutable: dropped with an explanation rather
            // than left at the head of the queue blocking everything behind it.
            onNone: () =>
              Effect.logError(
                "dropping an outbox op whose payload no longer decodes",
              ).pipe(
                Effect.andThen(sql`DELETE FROM outbox WHERE id = ${row.id}`),
                Effect.andThen(
                  withSummary((summary) =>
                    Rejected({
                      maybeRollback: Option.none(),
                      maybeSentThreadId: Option.none(),
                      message: "A queued action could not be read.",
                      summary,
                    }),
                  ),
                ),
              ),
            onSome: (op) => attempt(row.id, row.attempts, op),
          });
        },
      );

      /** Re-queues every failed send: the retry behind the toolbar's failed
       *  badge. Their bodies were kept precisely for this. */
      const retryFailedSends: Effect.Effect<void, SqlError> = sql`
        UPDATE outbox SET status = ${PENDING}, attempts = 0, last_error = ''
        WHERE status = ${FAILED}
      `.pipe(Effect.asVoid);

      return {
        drainStep,
        enqueue,
        reapplyPendingLabelOps,
        retryFailedSends,
        summary,
      } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(Gmail.layer, SqlLive)),
  );
}
