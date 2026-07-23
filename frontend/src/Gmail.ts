import { Context, Effect, Layer, Option, Schema as S } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { RateLimiter } from "effect/unstable/persistence";

import { AuthClient } from "./auth";

// Typed client for the Gmail REST API (the mail-client subset of the 80
// methods in reference/gmail.json — settings/delegation/S-MIME/CSE are
// deliberately not modeled). Transport-only: fetch, decode, classify
// errors. Cursors, paging loops, retry policy, and the local database
// belong to the SyncEngine in sync.ts.
//
// Every response is decoded through a schema before it reaches a caller,
// so API drift surfaces as a typed GmailDecodeError instead of undefined
// creeping into the database.

// IDS
//
// Branded so a MessageId can never be passed where a ThreadId is expected
// — the API would accept the string and 404 at runtime; the brand makes it
// a compile error instead.

export const MessageId = S.NonEmptyString.pipe(S.brand("GmailMessageId"));
export type MessageId = typeof MessageId.Type;

export const ThreadId = S.NonEmptyString.pipe(S.brand("GmailThreadId"));
export type ThreadId = typeof ThreadId.Type;

export const LabelId = S.NonEmptyString.pipe(S.brand("GmailLabelId"));
export type LabelId = typeof LabelId.Type;

export const AttachmentId = S.NonEmptyString.pipe(S.brand("GmailAttachmentId"));
export type AttachmentId = typeof AttachmentId.Type;

// Monotonic per-mailbox cursor (a stringified uint64 on the wire). The
// sync engine's incremental pulls hinge on this: persist the latest one,
// hand it to listHistory, and treat GmailNotFound there as "cursor
// expired, full resync required".
export const HistoryId = S.NonEmptyString.pipe(S.brand("GmailHistoryId"));
export type HistoryId = typeof HistoryId.Type;

export const PageToken = S.NonEmptyString.pipe(S.brand("GmailPageToken"));
export type PageToken = typeof PageToken.Type;

// Gmail body payloads are base64url (RFC 4648 §5, `-`/`_` alphabet), NOT
// plain base64 — atob() on this without translation corrupts bodies. The
// brand keeps "already decoded" and "still wire-encoded" strings apart.
export const Base64Url = S.String.pipe(S.brand("Base64Url"));
export type Base64Url = typeof Base64Url.Type;

// SCHEMAS
//
// Shapes mirror reference/gmail.json `schemas`. Fields the API documents
// but may omit (format-dependent: metadata vs full vs minimal) are
// optionalKey, so a decode of a minimal-format message still succeeds.

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

// MIME trees are recursive (multipart/* parts contain parts), so the
// schema needs an explicit interface + suspend. The encoded side is
// spelled out separately because the brands only exist on the Type side.
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
  // Epoch milliseconds as a string (int64 on the wire); when ordering by
  // it, Number() first — string comparison misorders across digit counts.
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
// Google's error envelope is uniform across every method:
//   { error: { code, message, status?, errors?: [{ reason?, domain? }] } }
// Classified into a closed union so the SyncEngine can catchTag
// exhaustively — each member dictates a different recovery.

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
 * call — expected for every write while sign-in only grants
 * gmail.readonly. Recovery is a scope upgrade via
 * linkSocial({ provider: "google", scopes: [...] }), not a retry. */
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

const classifyStatus = (
  status: number,
  retryAfterMs: number | undefined,
  body: unknown,
): GmailError => {
  const envelope = decodeEnvelope(body);
  const message = Option.match(envelope, {
    onNone: () => `Gmail request failed with HTTP ${status}.`,
    onSome: (e) => e.error.message,
  });
  const reason = Option.flatMapNullishOr(envelope, (e) =>
    e.error.errors?.find((detail) => detail.reason !== undefined),
  ).pipe(Option.flatMapNullishOr((detail) => detail.reason));

  if (status === 401) return new GmailAuthError({ message });
  if (status === 429) return new GmailRateLimited({ message, retryAfterMs });
  if (status === 403) {
    return Option.match(
      Option.filter(reason, (r) => RATE_LIMIT_REASONS.has(r)),
      {
        onSome: () => new GmailRateLimited({ message, retryAfterMs }),
        onNone: () =>
          new GmailScopeError({
            message,
            reason: Option.getOrUndefined(reason),
          }),
      },
    );
  }
  if (status === 404) return new GmailNotFound({ message });
  if (status >= 500) return new GmailServerError({ message, code: status });
  return new GmailInvalidRequest({ message, code: status });
};

// TRANSPORT

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

type QueryValue = string | number | boolean | ReadonlyArray<string> | undefined;

const parseRetryAfter = (header: string | undefined): number | undefined => {
  if (header === undefined) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
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
// average). Every request is paced through a token bucket weighted by
// Google's documented unit costs, with headroom under the ceiling, so
// sustained sync work never draws 429s in steady state. The limiter also
// learns from rate-limit/Retry-After response headers and replays 429s
// through the bucket, so the occasional disagreement self-corrects here
// before the SyncEngine ever sees a failure.

const QUOTA_WINDOW = "1 second";
const QUOTA_UNITS_PER_WINDOW = 200;

// Google's per-method quota unit table, keyed by URL shape. Order matters:
// an attachment URL also contains /messages/.
const quotaUnits = (request: HttpClientRequest.HttpClientRequest): number => {
  const url = request.url;
  if (url.includes("/attachments/")) return 5;
  if (url.includes("/history")) return 2;
  if (url.includes("/profile")) return 1;
  if (url.includes("/labels")) return 1;
  if (url.includes("/threads")) return 10;
  if (url.includes("/messages")) return 5;
  return 10;
};

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

    // Fresh token per request: getAccessToken refreshes server-side when
    // the stored one is expired, so callers never see a stale token, and
    // nothing token-shaped survives in this closure between calls.
    const accessToken = Effect.tryPromise(() =>
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

    // Effect.fn wraps every call in a named span, so each Gmail request
    // shows up in traces as "Gmail.request" with its own timing.
    const request = Effect.fn("Gmail.request")(function* <A>(
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
        body === undefined ? (r) => r : HttpClientRequest.bodyJsonUnsafe(body),
      );

      // The client only fails on transport problems; non-2xx statuses
      // come back as responses so we classify them ourselves against
      // Google's envelope.
      //
      // Tracer propagation must stay off: with a tracer active the client
      // adds traceparent/b3 headers, and Google's CORS preflight rejects
      // them ("No 'Access-Control-Allow-Origin' header is present") even
      // though its OPTIONS response claims to allow them. The Gmail.request
      // span itself is unaffected — only the outgoing headers are dropped.
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

      /** All labels — system (INBOX, UNREAD, …) and user-created. */
      listLabels: request(ListLabelsResponse, "GET", "/labels"),

      /**
       * The incremental-sync primitive: every mailbox change since
       * `startHistoryId`, in order. `GmailNotFound` here has a specific
       * meaning — the cursor expired (Gmail keeps roughly a week of
       * history) — and the recovery is a full {@link listThreads} resync,
       * not a retry.
       */
      listHistory: (options: ListHistoryOptions) =>
        request(ListHistoryResponse, "GET", "/history", { ...options }),

      // WRITES (fail with GmailScopeError until scopes beyond
      // gmail.readonly are granted via linkSocial)

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
