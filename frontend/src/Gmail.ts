import {
  Array as Arr,
  Context,
  Effect,
  Function,
  Layer,
  Match as M,
  Option,
  Schema as S,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { RateLimiter } from "effect/unstable/persistence";

import { AuthClient } from "./auth";

// Typed client for the Gmail REST API. Transport only: fetch, decode,
// classify errors. Cursors, paging, retry policy, and the local database
// belong to the SyncEngine in sync.ts.

// IDS
//
// NOTE: Branded so a MessageId can never be passed where a ThreadId is
// expected. The API would accept the string and 404 at runtime.

export const MessageId = S.NonEmptyString.pipe(S.brand("GmailMessageId"));
export type MessageId = typeof MessageId.Type;

export const ThreadId = S.NonEmptyString.pipe(S.brand("GmailThreadId"));
export type ThreadId = typeof ThreadId.Type;

export const LabelId = S.NonEmptyString.pipe(S.brand("GmailLabelId"));
export type LabelId = typeof LabelId.Type;

// The system labels the app reads and writes. Every mailbox state the UI
// exposes is one of these: which folder a thread lives in, unread, starred.
// Named once here because both the sync's extraction and the outbox's label
// edits key off them, and a typo in either place is a silent no-op rather
// than an error.
export const INBOX_LABEL = LabelId.make("INBOX");
export const UNREAD_LABEL = LabelId.make("UNREAD");
export const STARRED_LABEL = LabelId.make("STARRED");
export const SENT_LABEL = LabelId.make("SENT");
export const DRAFT_LABEL = LabelId.make("DRAFT");
export const SPAM_LABEL = LabelId.make("SPAM");
export const TRASH_LABEL = LabelId.make("TRASH");

export const AttachmentId = S.NonEmptyString.pipe(S.brand("GmailAttachmentId"));
export type AttachmentId = typeof AttachmentId.Type;

// NOTE: Monotonic per-mailbox cursor. GmailNotFound from listHistory means
// the cursor expired and a full resync is required.
export const HistoryId = S.NonEmptyString.pipe(S.brand("GmailHistoryId"));
export type HistoryId = typeof HistoryId.Type;

export const PageToken = S.NonEmptyString.pipe(S.brand("GmailPageToken"));
export type PageToken = typeof PageToken.Type;

// NOTE: Gmail body payloads are base64url (RFC 4648 §5, `-`/`_` alphabet),
// not plain base64; atob() without translation corrupts bodies. The brand
// keeps "already decoded" and "still wire-encoded" strings apart.
export const Base64Url = S.String.pipe(S.brand("Base64Url"));
export type Base64Url = typeof Base64Url.Type;

// SCHEMAS
//
// NOTE: Fields the API may omit depending on format (metadata vs full vs
// minimal) are optionalKey, so a minimal-format decode still succeeds.

export const Profile = S.Struct({
  emailAddress: S.String,
  messagesTotal: S.Number,
  threadsTotal: S.Number,
  historyId: HistoryId,
});
export type Profile = typeof Profile.Type;

export const MessagePartHeader = S.Struct({
  name: S.String,
  value: S.String,
});
export type MessagePartHeader = typeof MessagePartHeader.Type;

export const MessagePartBody = S.Struct({
  size: S.Number,
  attachmentId: S.optionalKey(AttachmentId),
  data: S.optionalKey(Base64Url),
});
export type MessagePartBody = typeof MessagePartBody.Type;

// NOTE: MIME trees are recursive, so the schema needs an explicit interface +
// suspend. The encoded side is spelled out separately because the brands only
// exist on the Type side.
export interface MessagePart {
  readonly partId?: string;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: ReadonlyArray<MessagePartHeader>;
  readonly body?: MessagePartBody;
  readonly parts?: ReadonlyArray<MessagePart>;
}

interface MessagePartEncoded {
  readonly partId?: string;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: ReadonlyArray<(typeof MessagePartHeader)["Encoded"]>;
  readonly body?: (typeof MessagePartBody)["Encoded"];
  readonly parts?: ReadonlyArray<MessagePartEncoded>;
}

export const MessagePart: S.Codec<MessagePart, MessagePartEncoded> = S.Struct({
  partId: S.optionalKey(S.String),
  mimeType: S.optionalKey(S.String),
  filename: S.optionalKey(S.String),
  headers: S.optionalKey(S.Array(MessagePartHeader)),
  body: S.optionalKey(MessagePartBody),
  parts: S.optionalKey(
    S.Array(
      S.suspend((): S.Codec<MessagePart, MessagePartEncoded> => MessagePart),
    ),
  ),
});

export const Message = S.Struct({
  id: MessageId,
  threadId: ThreadId,
  labelIds: S.optionalKey(S.Array(LabelId)),
  snippet: S.optionalKey(S.String),
  historyId: S.optionalKey(HistoryId),
  // NOTE: Epoch millis as a string. Order by Number(), not the string:
  // string comparison misorders across digit counts.
  internalDate: S.optionalKey(S.String),
  sizeEstimate: S.optionalKey(S.Number),
  payload: S.optionalKey(MessagePart),
  raw: S.optionalKey(Base64Url),
});
export type Message = typeof Message.Type;

export const Thread = S.Struct({
  id: ThreadId,
  historyId: S.optionalKey(HistoryId),
  snippet: S.optionalKey(S.String),
  messages: S.optionalKey(S.Array(Message)),
});
export type Thread = typeof Thread.Type;

export const ListThreadsResponse = S.Struct({
  threads: S.optionalKey(S.Array(Thread)),
  nextPageToken: S.optionalKey(PageToken),
  resultSizeEstimate: S.optionalKey(S.Number),
});
export type ListThreadsResponse = typeof ListThreadsResponse.Type;

export const ListMessagesResponse = S.Struct({
  messages: S.optionalKey(S.Array(Message)),
  nextPageToken: S.optionalKey(PageToken),
  resultSizeEstimate: S.optionalKey(S.Number),
});
export type ListMessagesResponse = typeof ListMessagesResponse.Type;

export const Label = S.Struct({
  id: LabelId,
  name: S.String,
  type: S.optionalKey(S.Literals(["system", "user"])),
  messageListVisibility: S.optionalKey(S.Literals(["show", "hide"])),
  labelListVisibility: S.optionalKey(
    S.Literals(["labelShow", "labelShowIfUnread", "labelHide"]),
  ),
  messagesTotal: S.optionalKey(S.Number),
  messagesUnread: S.optionalKey(S.Number),
  threadsTotal: S.optionalKey(S.Number),
  threadsUnread: S.optionalKey(S.Number),
});
export type Label = typeof Label.Type;

export const ListLabelsResponse = S.Struct({
  labels: S.optionalKey(S.Array(Label)),
});
export type ListLabelsResponse = typeof ListLabelsResponse.Type;

const HistoryMessage = S.Struct({ message: Message });
const HistoryLabelChange = S.Struct({
  message: Message,
  labelIds: S.optionalKey(S.Array(LabelId)),
});

export const History = S.Struct({
  id: HistoryId,
  messages: S.optionalKey(S.Array(Message)),
  messagesAdded: S.optionalKey(S.Array(HistoryMessage)),
  messagesDeleted: S.optionalKey(S.Array(HistoryMessage)),
  labelsAdded: S.optionalKey(S.Array(HistoryLabelChange)),
  labelsRemoved: S.optionalKey(S.Array(HistoryLabelChange)),
});
export type History = typeof History.Type;

export const ListHistoryResponse = S.Struct({
  history: S.optionalKey(S.Array(History)),
  historyId: S.optionalKey(HistoryId),
  nextPageToken: S.optionalKey(PageToken),
});
export type ListHistoryResponse = typeof ListHistoryResponse.Type;

// ERRORS
//
// Classified into a closed union so the SyncEngine can catchTag exhaustively;
// each member dictates a different recovery.

const GoogleErrorEnvelope = S.Struct({
  error: S.Struct({
    code: S.Number,
    message: S.String,
    status: S.optionalKey(S.String),
    errors: S.optionalKey(
      S.Array(
        S.Struct({
          reason: S.optionalKey(S.String),
          domain: S.optionalKey(S.String),
          message: S.optionalKey(S.String),
        }),
      ),
    ),
  }),
});
const decodeEnvelope = S.decodeUnknownOption(GoogleErrorEnvelope);

/** Could not obtain a Google access token from BetterAuth (no session, no
 * linked Google account, or the refresh failed). Not retryable; the user
 * must re-authenticate or re-link. */
export class GmailTokenError extends S.TaggedErrorClass<GmailTokenError>()(
  "GmailTokenError",
  { message: S.String },
) {}

/** fetch itself rejected (offline, DNS, CORS). Retryable once back online. */
export class GmailNetworkError extends S.TaggedErrorClass<GmailNetworkError>()(
  "GmailNetworkError",
  { message: S.String },
) {}

/** 401: the access token was rejected (revoked or malformed). Not
 * retryable — surface re-auth. */
export class GmailAuthError extends S.TaggedErrorClass<GmailAuthError>()(
  "GmailAuthError",
  { message: S.String },
) {}

/** 403 without a rate-limit reason: the granted scopes don't cover this
 * call. Sign-in grants modify and send alongside readonly, so this now means
 * a session older than that change. Recovery is signing in again (which
 * re-consents), not a retry. */
export class GmailScopeError extends S.TaggedErrorClass<GmailScopeError>()(
  "GmailScopeError",
  { message: S.String, reason: S.optionalKey(S.String) },
) {}

/** 429, or 403 with a usage-limit reason. Retryable after backoff;
 * retryAfterMs is populated from the Retry-After header when present. */
export class GmailRateLimited extends S.TaggedErrorClass<GmailRateLimited>()(
  "GmailRateLimited",
  { message: S.String, retryAfterMs: S.optionalKey(S.Number) },
) {}

/** 404. On listHistory this specifically means the startHistoryId cursor
 * has expired — the sync engine must fall back to a full resync. */
export class GmailNotFound extends S.TaggedErrorClass<GmailNotFound>()(
  "GmailNotFound",
  { message: S.String },
) {}

/** 400/412 and any unclassified 4xx: the request itself is wrong. A bug
 * on our side; retrying the same call cannot succeed. */
export class GmailInvalidRequest extends S.TaggedErrorClass<GmailInvalidRequest>()(
  "GmailInvalidRequest",
  { message: S.String, code: S.Number },
) {}

/** 5xx. Google's fault; retryable with exponential backoff. */
export class GmailServerError extends S.TaggedErrorClass<GmailServerError>()(
  "GmailServerError",
  { message: S.String, code: S.Number },
) {}

/** A 2xx body that doesn't match our schema: API drift or a bug in these
 * schemas. Not retryable; log loudly. */
export class GmailDecodeError extends S.TaggedErrorClass<GmailDecodeError>()(
  "GmailDecodeError",
  { message: S.String },
) {}

export type GmailError =
  | GmailTokenError
  | GmailNetworkError
  | GmailAuthError
  | GmailScopeError
  | GmailRateLimited
  | GmailNotFound
  | GmailInvalidRequest
  | GmailServerError
  | GmailDecodeError;

const RATE_LIMIT_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "quotaExceeded",
]);

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

const classifyStatus = (
  status: number,
  retryAfterMs: number | undefined,
  body: unknown,
): GmailError => {
  const maybeEnvelope = decodeEnvelope(body);
  const message = Option.match(maybeEnvelope, {
    onNone: () => `Gmail request failed with HTTP ${status}.`,
    onSome: (envelope) => envelope.error.message,
  });
  const maybeReason = Option.flatMap(maybeEnvelope, (envelope) =>
    Option.flatMap(
      Arr.findFirst(
        envelope.error.errors ?? [],
        (detail) => detail.reason !== undefined,
      ),
      (detail) => Option.fromNullishOr(detail.reason),
    ),
  );

  // 403 is overloaded: a usage-limit reason means back off, anything else
  // means the granted scopes don't cover the call.
  const classifyForbidden = (): GmailError =>
    Option.match(
      Option.filter(maybeReason, (reason) => RATE_LIMIT_REASONS.has(reason)),
      {
        onSome: () => new GmailRateLimited({ message, retryAfterMs }),
        onNone: () =>
          new GmailScopeError({
            message,
            reason: Option.getOrUndefined(maybeReason),
          }),
      },
    );

  return M.value(status).pipe(
    M.withReturnType<GmailError>(),
    M.when(HTTP_UNAUTHORIZED, () => new GmailAuthError({ message })),
    M.when(
      HTTP_TOO_MANY_REQUESTS,
      () => new GmailRateLimited({ message, retryAfterMs }),
    ),
    M.when(HTTP_FORBIDDEN, classifyForbidden),
    M.when(HTTP_NOT_FOUND, () => new GmailNotFound({ message })),
    M.when(
      (code) => code >= HTTP_SERVER_ERROR,
      () => new GmailServerError({ message, code: status }),
    ),
    M.orElse(() => new GmailInvalidRequest({ message, code: status })),
  );
};

// TRANSPORT

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

type QueryValue = string | number | boolean | ReadonlyArray<string> | undefined;

// Absent, or a non-numeric value, both come back undefined: Number(undefined)
// is NaN and so fails the finite check on its own.
const parseRetryAfter = (header: string | undefined): number | undefined => {
  const milliseconds = Number(header) * 1000;
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
};

// SERVICE

export interface ListThreadsOptions {
  readonly labelIds?: ReadonlyArray<LabelId>;
  readonly q?: string;
  readonly maxResults?: number;
  readonly pageToken?: PageToken;
  readonly includeSpamTrash?: boolean;
}

export interface ListHistoryOptions {
  readonly startHistoryId: HistoryId;
  readonly labelId?: LabelId;
  readonly maxResults?: number;
  readonly pageToken?: PageToken;
}

export type MessageFormat = "minimal" | "metadata" | "full" | "raw";

export interface ModifyLabels {
  readonly addLabelIds?: ReadonlyArray<LabelId>;
  readonly removeLabelIds?: ReadonlyArray<LabelId>;
}

// QUOTA
//
// Gmail's binding limit is 250 quota units per user per second (a moving
// average). Every request is paced through a token bucket weighted by Google's
// documented unit costs, with headroom under the ceiling, so sustained sync
// work never draws 429s in steady state. The limiter also learns from
// Retry-After headers and replays 429s through the bucket, so the occasional
// disagreement self-corrects before the SyncEngine sees a failure.

const QUOTA_WINDOW = "1 second";
const QUOTA_UNITS_PER_WINDOW = 200;

/** What one thread costs to fetch (`threads.get`), per Google's table. */
const THREAD_GET_UNITS = 10;

/** Sustained thread throughput the bucket allows. The bucket, not the
 *  concurrency setting, is what binds the backfill, so this is the real
 *  steady-state rate and the basis for the sync time estimate. Raising
 *  QUOTA_UNITS_PER_WINDOW moves this number and the estimate together. */
export const THREADS_PER_SECOND = QUOTA_UNITS_PER_WINDOW / THREAD_GET_UNITS;

// Google's per-method quota unit table, keyed by URL shape.
// NOTE: Order matters. An attachment URL also contains /messages/, so the
// first match wins and the narrower fragments come first.
const QUOTA_UNITS_BY_PATH: ReadonlyArray<readonly [string, number]> = [
  // Sending is by far the most expensive call in the table, and its URL also
  // contains /messages, so it has to be matched before that entry.
  ["/send", 100],
  ["/attachments/", 5],
  ["/history", 2],
  ["/profile", 1],
  ["/labels", 1],
  ["/threads", 10],
  ["/messages", 5],
];
const DEFAULT_QUOTA_UNITS = 10;

const quotaUnits = (request: HttpClientRequest.HttpClientRequest): number =>
  Option.getOrElse(
    Arr.findFirst(QUOTA_UNITS_BY_PATH, ([fragment, units]) =>
      request.url.includes(fragment) ? Option.some(units) : Option.none(),
    ),
    () => DEFAULT_QUOTA_UNITS,
  );

export class Gmail extends Context.Service<Gmail>()("parcel/Gmail", {
  make: Effect.gen(function* () {
    const authClient = yield* AuthClient;
    const limiter = yield* RateLimiter.RateLimiter;
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.withRateLimiter({
        limiter,
        window: QUOTA_WINDOW,
        limit: QUOTA_UNITS_PER_WINDOW,
        key: "gmail",
        algorithm: "token-bucket",
        tokens: quotaUnits,
      }),
    );

    const fetchAccessToken = Effect.tryPromise(() =>
      authClient.getAccessToken({ providerId: "google" }),
    ).pipe(
      Effect.mapError(
        (cause) => new GmailTokenError({ message: String(cause) }),
      ),
      Effect.flatMap(({ data, error }) =>
        data !== null && error === null
          ? Effect.succeed(data.accessToken)
          : Effect.fail(
              new GmailTokenError({
                message:
                  error?.message ?? "No Google access token is available.",
              }),
            ),
      ),
    );

    // NOTE: getAccessToken is a round-trip to our own backend, so running it
    // per Gmail call put our server in front of every API call and doubled a
    // backfill's request count. Google's tokens last an hour; a five-minute
    // cache keeps refresh-on-expiry while collapsing thousands of calls into a
    // handful. It is also what makes a mid-flight 401 possible, which is why
    // `request` below invalidates and retries once.
    const [accessToken, invalidateAccessToken] =
      yield* Effect.cachedInvalidateWithTTL(fetchAccessToken, "5 minutes");

    // Effect.fn wraps every call in a named span, so each Gmail request
    // shows up in traces as "Gmail.request" with its own timing.
    const sendOnce = Effect.fn("Gmail.request")(function* <A>(
      // `any` on the encoded side: response schemas carry brands on the
      // Type side only, and pinning Encoded would unify A with it.
      schema: S.Codec<A, any>,
      method: "GET" | "POST",
      path: string,
      query: Record<string, QueryValue> = {},
      body?: unknown,
    ) {
      const token = yield* accessToken;
      const make =
        method === "GET" ? HttpClientRequest.get : HttpClientRequest.post;
      const req = make(`${BASE_URL}${path}`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.acceptJson,
        // UrlParams drops undefined values and repeats array entries
        // (labelIds=A&labelIds=B) — how the API encodes them.
        HttpClientRequest.appendUrlParams(query),
        body === undefined
          ? Function.identity
          : HttpClientRequest.bodyJsonUnsafe(body),
      );

      // The client only fails on transport problems; non-2xx statuses come
      // back as responses, so we classify them against Google's envelope.
      // NOTE: Tracer propagation must stay off. With a tracer active the
      // client adds traceparent/b3 headers, and Google's CORS preflight
      // rejects them even though its OPTIONS response claims to allow them.
      // Only the outgoing headers are dropped; the Gmail.request span is fine.
      const response = yield* http.execute(req).pipe(
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(
          (cause) => new GmailNetworkError({ message: String(cause) }),
        ),
      );

      if (response.status < 200 || response.status >= 300) {
        const errorBody = yield* response.json.pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        return yield* classifyStatus(
          response.status,
          parseRetryAfter(response.headers["retry-after"]),
          errorBody,
        );
      }

      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(
          (issue) => new GmailDecodeError({ message: String(issue) }),
        ),
      );
    });

    // An auth failure on a cached token is ambiguous: the grant may be gone,
    // or the string may just have gone stale inside the TTL. Drop the cache
    // and try once more; a second failure is the genuine answer.
    const request = <A>(
      schema: S.Codec<A, any>,
      method: "GET" | "POST",
      path: string,
      query: Record<string, QueryValue> = {},
      body?: unknown,
    ) =>
      sendOnce(schema, method, path, query, body).pipe(
        Effect.catchTag("GmailAuthError", (error) =>
          invalidateAccessToken.pipe(
            Effect.andThen(sendOnce(schema, method, path, query, body)),
            // Preserve the original failure if the retry is refused before
            // it reaches Google.
            Effect.catchTag("GmailTokenError", () => Effect.fail(error)),
          ),
        ),
      );

    return {
      // READS (covered by gmail.readonly)

      /**
       * The mailbox's identity and counters. The returned `historyId` is a
       * valid starting cursor for {@link listHistory}, which makes this the
       * cheapest way to bootstrap incremental sync — and the ideal smoke
       * test for the whole token → fetch → decode chain.
       */
      getProfile: request(Profile, "GET", "/profile"),

      /**
       * One page of thread stubs (id/historyId/snippet only — no
       * messages). `q` takes full Gmail search syntax; follow
       * `nextPageToken` until it's absent for the full mailbox.
       */
      listThreads: (options: ListThreadsOptions = {}) =>
        request(ListThreadsResponse, "GET", "/threads", { ...options }),

      /**
       * A thread with its messages. Default `full` format includes decoded
       * MIME payloads; use `metadata` when only headers are needed (much
       * smaller, and permitted by narrower scopes).
       */
      getThread: (id: ThreadId, format: MessageFormat = "full") =>
        request(Thread, "GET", `/threads/${id}`, { format }),

      /**
       * One page of message stubs (id/threadId only). Same paging and `q`
       * semantics as {@link listThreads}.
       */
      listMessages: (options: ListThreadsOptions = {}) =>
        request(ListMessagesResponse, "GET", "/messages", { ...options }),

      /**
       * A single message. `full` yields the MIME tree in `payload`; `raw`
       * yields the whole RFC 2822 message base64url-encoded in `raw`.
       */
      getMessage: (id: MessageId, format: MessageFormat = "full") =>
        request(Message, "GET", `/messages/${id}`, { format }),

      /**
       * An attachment body. Attachments over ~1MB are not inlined in
       * {@link getMessage} payloads — the part carries an `attachmentId`
       * pointing here instead. `data` is base64url.
       */
      getAttachment: (messageId: MessageId, id: AttachmentId) =>
        request(
          MessagePartBody,
          "GET",
          `/messages/${messageId}/attachments/${id}`,
        ),

      /** All labels — system (INBOX, UNREAD, …) and user-created. Note that
       *  the list form omits the counters; use {@link getLabel} for those. */
      listLabels: request(ListLabelsResponse, "GET", "/labels"),

      /**
       * One label, including its `threadsTotal`/`messagesTotal` counters —
       * the only way to ask how big a *label* is. `getProfile.threadsTotal`
       * counts the whole mailbox (All Mail, Sent, Spam, Trash), so it is the
       * wrong denominator for anything scoped to a label.
       */
      getLabel: (id: LabelId) => request(Label, "GET", `/labels/${id}`),

      /**
       * The incremental-sync primitive: every mailbox change since
       * `startHistoryId`, in order. `GmailNotFound` here has a specific
       * meaning — the cursor expired (Gmail keeps roughly a week of
       * history) — and the recovery is a full {@link listThreads} resync,
       * not a retry.
       */
      listHistory: (options: ListHistoryOptions) =>
        request(ListHistoryResponse, "GET", "/history", { ...options }),

      // WRITES (covered by gmail.modify and gmail.send; a session predating
      // those scopes fails with GmailScopeError until it signs in again)

      /**
       * Add/remove labels on one message. Archiving, marking read, and
       * starring are all label edits (remove INBOX, remove UNREAD, add
       * STARRED).
       */
      modifyMessage: (id: MessageId, labels: ModifyLabels) =>
        request(Message, "POST", `/messages/${id}/modify`, {}, labels),

      /** Label edit applied to every message in the thread at once. */
      modifyThread: (id: ThreadId, labels: ModifyLabels) =>
        request(Thread, "POST", `/threads/${id}/modify`, {}, labels),

      /** Move a whole thread to trash (auto-deleted by Gmail ~30 days later). */
      trashThread: (id: ThreadId) =>
        request(Thread, "POST", `/threads/${id}/trash`),

      /** Restore a thread from trash. */
      untrashThread: (id: ThreadId) =>
        request(Thread, "POST", `/threads/${id}/untrash`),

      /**
       * Send a complete RFC 2822 message, base64url-encoded (the brand
       * enforces callers did the -/_ encoding, not plain btoa). Pass
       * `threadId` to keep a reply in its thread — Gmail also requires the
       * References/In-Reply-To headers inside `raw` for threading to hold.
       */
      sendRaw: (raw: Base64Url, threadId?: ThreadId) =>
        request(Message, "POST", "/messages/send", {}, { raw, threadId }),
    } as const;
  }),
}) {
  static readonly layer: Layer.Layer<Gmail> = Layer.effect(
    this,
    this.make,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AuthClient.layer,
        FetchHttpClient.layer,
        // Process-local limiter store: the quota bucket lives and dies
        // with the tab. (A second tab gets its own bucket — the multi-tab
        // sync-leader question is open regardless.)
        RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
      ),
    ),
  );
}
