// What can be queued for Gmail, and what a failure to send it means.
//
// Pure data and pure functions: the ops the outbox stores, the local effect
// each one has, its inverse (which is how a rejected op is rolled back), and
// the classification that decides whether a failure is worth retrying. The
// engine in outboxEngine.ts executes them; the machine in outboxMachine.ts
// decides when.

import { Effect, Match as M, Option, Schema as S } from "effect";
import { ts } from "foldkit/schema";

import {
  INBOX_LABEL,
  LabelId,
  STARRED_LABEL,
  ThreadId,
  UNREAD_LABEL,
  type GmailError,
} from "./Gmail";

import type { SqlError } from "effect/unstable/sql/SqlError";

// OPS

/**
 * A label edit on a whole thread. Archiving, marking read, and starring are
 * all this one op — Gmail models them as label membership, and so does the
 * local store.
 *
 * NOTE: Idempotent by construction. Adding a label a thread already carries
 * is a no-op at both ends, which is what makes a retry after an ambiguous
 * failure safe.
 */
// The `kind` column stores these, so they are named once rather than spelled
// in a query where a rename could not reach them.
export const MODIFY_THREAD_LABELS = "ModifyThreadLabels";
export const SEND_MESSAGE = "SendMessage";

export const ModifyThreadLabels = ts(MODIFY_THREAD_LABELS, {
  threadId: ThreadId,
  addLabelIds: S.Array(LabelId),
  removeLabelIds: S.Array(LabelId),
});
export type ModifyThreadLabels = typeof ModifyThreadLabels.Type;

/** A composed message. `bodyHtml` is rendered at enqueue time rather than at
 *  send time, so the drain is a dumb executor and what was previewed is
 *  exactly what goes out. */
// NOTE: OptionFromNullOr, not S.Option. An op is stored as JSON in the
// outbox's `payload` column, and S.Option's *encoded* side is the Option
// instance itself — JSON.stringify turns that into `{"_id":"Option",…}`,
// which does not decode back. A send that cannot be decoded is a send that
// silently never goes out, so the persisted shape has to be plain JSON:
// `null` for None, the value for Some.
export const SendMessage = ts(SEND_MESSAGE, {
  to: S.Array(S.String),
  subject: S.String,
  bodyMarkdown: S.String,
  bodyHtml: S.String,
  /** Some for a reply: Gmail threads the sent copy in *our* mailbox by id. */
  maybeThreadId: S.OptionFromNullOr(ThreadId),
  /** Some for a reply: the parent's Message-ID, which threads it in the
   *  recipient's client. */
  maybeInReplyTo: S.OptionFromNullOr(S.String),
  references: S.String,
});
export type SendMessage = typeof SendMessage.Type;

export const OutboxOp = S.Union([ModifyThreadLabels, SendMessage]);
export type OutboxOp = typeof OutboxOp.Type;

export const encodeOutboxOp = S.encodeSync(OutboxOp);

const decodeOp = S.decodeUnknownEffect(OutboxOp);

/**
 * The stored `payload` column back into an op, or `None`.
 *
 * NOTE: Total, because this reads a string the app itself wrote: a payload
 * that no longer decodes is a bug in this schema pair, and the honest
 * response is to drop that one queue row rather than to take a mailbox down
 * over it. JSON.parse throws rather than failing, hence the suspend.
 */
export const decodeOutboxPayload = (
  payload: string,
): Effect.Effect<Option.Option<OutboxOp>> =>
  Effect.try(() => JSON.parse(payload) as unknown).pipe(
    Effect.flatMap(decodeOp),
    Effect.map(Option.some),
    Effect.catchCause(() => Effect.succeedNone),
  );

// CONSTRUCTORS
//
// The three flag actions, spelled as the label edits they are. Each takes
// the state the thread is in now, so the call site never has to work out
// which direction the toggle goes.

const labelOp = (
  threadId: ThreadId,
  label: LabelId,
  isAdding: boolean,
): ModifyThreadLabels =>
  ModifyThreadLabels({
    threadId,
    addLabelIds: isAdding ? [label] : [],
    removeLabelIds: isAdding ? [] : [label],
  });

export const starOp = (
  threadId: ThreadId,
  isStarred: boolean,
): ModifyThreadLabels => labelOp(threadId, STARRED_LABEL, !isStarred);

export const readOp = (
  threadId: ThreadId,
  isUnread: boolean,
): ModifyThreadLabels => labelOp(threadId, UNREAD_LABEL, !isUnread);

export const archiveOp = (threadId: ThreadId): ModifyThreadLabels =>
  labelOp(threadId, INBOX_LABEL, false);

/** The op that undoes this one. Rolling back a rejected label edit is
 *  applying its inverse locally and letting the next history pass confirm. */
export const inverseOf = (op: ModifyThreadLabels): ModifyThreadLabels =>
  ModifyThreadLabels({
    threadId: op.threadId,
    addLabelIds: op.removeLabelIds,
    removeLabelIds: op.addLabelIds,
  });

// LOCAL EFFECT

/**
 * What one op changes about a thread row, as three independent questions.
 * `None` means "this op says nothing about that column", which is what keeps
 * an archive from also claiming something about the star.
 *
 * The model applies this to a single row by id. Re-reading the list instead
 * would re-decode every row in the store to change one of them, and hand
 * every memoized row subtree a new object in the process.
 */
export const ThreadPatch = S.Struct({
  threadId: ThreadId,
  maybeIsUnread: S.Option(S.Boolean),
  maybeIsStarred: S.Option(S.Boolean),
  /** Archived: the row leaves the inbox list. */
  isRemoved: S.Boolean,
});
export type ThreadPatch = typeof ThreadPatch.Type;

const labelChange = (
  op: ModifyThreadLabels,
  label: LabelId,
): Option.Option<boolean> => {
  if (op.addLabelIds.includes(label)) {
    return Option.some(true);
  }
  return op.removeLabelIds.includes(label) ? Option.some(false) : Option.none();
};

export const patchOf = (op: ModifyThreadLabels): ThreadPatch => ({
  threadId: op.threadId,
  maybeIsUnread: labelChange(op, UNREAD_LABEL),
  maybeIsStarred: labelChange(op, STARRED_LABEL),
  // NOTE: Only removal matters. A thread gaining INBOX has arrived rather
  // than been un-archived, and that reaches the list through the sync.
  isRemoved: op.removeLabelIds.includes(INBOX_LABEL),
});

// FAILURE

/** Worth trying again: the network, Google's side, or a rate limit. */
export const Transient = ts("Transient", {
  maybeRetryAfterMs: S.Option(S.Number),
});
/** The grant is gone or too narrow. Retrying changes nothing; the op waits
 *  where it is until the user reconnects. */
export const Unauthorized = ts("Unauthorized");
/** This op will never succeed. Label edits roll back, sends are kept as
 *  failed drafts. */
export const Permanent = ts("Permanent", { message: S.String });

export const OpFailure = S.Union([Transient, Unauthorized, Permanent]);
export type OpFailure = typeof OpFailure.Type;

/** Past this many consecutive failures an op is treated as permanent. At the
 *  capped backoff that is roughly ten minutes of trying, which is long enough
 *  to outlast a tunnel and short enough that a genuinely broken op doesn't
 *  block the queue behind it forever. */
export const MAX_ATTEMPTS = 8;

/**
 * NOTE: The default is Transient, deliberately. An error we failed to
 * anticipate is more likely a blip than a permanent rejection, and the
 * attempt cap converts a wrong guess into a permanent failure on its own —
 * whereas guessing Permanent throws away a send that would have gone out.
 */
export const classifyFailure = (error: GmailError | SqlError): OpFailure =>
  M.value(error).pipe(
    M.withReturnType<OpFailure>(),
    M.tags({
      GmailAuthError: () => Unauthorized(),
      GmailTokenError: () => Unauthorized(),
      GmailScopeError: () => Unauthorized(),
      GmailRateLimited: ({ retryAfterMs }) =>
        Transient({ maybeRetryAfterMs: Option.fromNullishOr(retryAfterMs) }),
      // The thread or message is gone, and the request itself is malformed:
      // both are settled answers, not slow ones.
      GmailNotFound: ({ message }) => Permanent({ message }),
      GmailInvalidRequest: ({ message }) => Permanent({ message }),
      GmailDecodeError: ({ message }) => Permanent({ message }),
    }),
    M.orElse(() => Transient({ maybeRetryAfterMs: Option.none() })),
  );

/** The failure an op that has run out of attempts reports instead. */
export const exhaustedFailure = (attempts: number): OpFailure =>
  Permanent({ message: `Gave up after ${attempts} attempts.` });
