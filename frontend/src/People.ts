// Typed client for the Google People API, used for exactly one thing: the
// profile photos behind sender avatars (avatars.ts).
//
// Transport only, like Gmail.ts — what to do with the photos, when to refresh
// them, and where the bytes are stored is the SyncEngine's business.
//
// NOTE: Its own HttpClient, deliberately NOT the one in Gmail.ts. That client
// is wrapped in a token bucket sized to Gmail's 250 quota-units/second, and
// People bills against a separate quota entirely. Sharing the bucket would let
// a contacts pull steal budget from the backfill and slow the mailbox down for
// pictures.

import { Context, Effect, Layer, Option, Schema as S } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { AuthClient } from "./auth";

const BASE_URL = "https://people.googleapis.com/v1";

// The largest page either endpoint allows. Contact lists are small next to a
// mailbox — a few requests covers almost everyone.
const CONNECTIONS_PAGE_SIZE = 1000;
const OTHER_CONTACTS_PAGE_SIZE = 1000;

export class PeopleError extends S.TaggedErrorClass<PeopleError>()(
  "PeopleError",
  { message: S.String },
) {}

// RESPONSES
//
// NOTE: Everything optional. A person may have no photo, no address, or
// neither, and the API omits rather than nulls. Decoding is deliberately
// permissive: this whole feature is decoration, and a schema that fails the
// pass because one contact is shaped oddly would trade a picture for a broken
// sync.

const Photo = S.Struct({
  url: S.optionalKey(S.String),
  /** Google's generic gray silhouette, which every photo-less account has.
   *  The whole reason this field is decoded — see `realPhotoUrl`. */
  default: S.optionalKey(S.Boolean),
});

const EmailAddress = S.Struct({ value: S.optionalKey(S.String) });

const Person = S.Struct({
  emailAddresses: S.optionalKey(S.Array(EmailAddress)),
  photos: S.optionalKey(S.Array(Photo)),
});

const ConnectionsResponse = S.Struct({
  connections: S.optionalKey(S.Array(Person)),
  nextPageToken: S.optionalKey(S.String),
});

const OtherContactsResponse = S.Struct({
  otherContacts: S.optionalKey(S.Array(Person)),
  nextPageToken: S.optionalKey(S.String),
});

/** One person's usable photo: an address to key it by, and a url to fetch. */
export type PersonPhoto = Readonly<{ email: string; photoUrl: string }>;

// NOTE: `default: true` marks the placeholder avatar Google hands out for
// accounts with no photo. Keeping those would replace every letter tile in the
// mailbox with the same gray silhouette — strictly less information than the
// initial it displaced, repeated a thousand times.
const realPhotoUrl = (person: typeof Person.Type): Option.Option<string> =>
  Option.fromNullishOr(
    (person.photos ?? []).find(
      (photo) => photo.default !== true && (photo.url ?? "") !== "",
    )?.url,
  );

const primaryEmail = (person: typeof Person.Type): Option.Option<string> =>
  Option.map(
    Option.fromNullishOr(
      (person.emailAddresses ?? []).find(
        (address) => (address.value ?? "") !== "",
      )?.value,
    ),
    (value) => value.trim().toLowerCase(),
  );

const photosOf = (
  people: ReadonlyArray<typeof Person.Type>,
): ReadonlyArray<PersonPhoto> =>
  people.flatMap((person) =>
    Option.match(
      Option.zipWith(
        primaryEmail(person),
        realPhotoUrl(person),
        (email, photoUrl): PersonPhoto => ({ email, photoUrl }),
      ),
      {
        onNone: (): ReadonlyArray<PersonPhoto> => [],
        onSome: (photo) => [photo],
      },
    ),
  );

export class People extends Context.Service<People>()("parcel/People", {
  make: Effect.gen(function* () {
    const authClient = yield* AuthClient;
    const http = yield* HttpClient.HttpClient;

    const accessToken = Effect.tryPromise(() =>
      authClient.getAccessToken({ providerId: "google" }),
    ).pipe(
      Effect.mapError((cause) => new PeopleError({ message: String(cause) })),
      Effect.flatMap(({ data, error }) =>
        data !== null && error === null
          ? Effect.succeed(data.accessToken)
          : Effect.fail(
              new PeopleError({
                message:
                  error?.message ?? "No Google access token is available.",
              }),
            ),
      ),
    );

    const request = <A>(
      schema: S.Codec<A, any>,
      path: string,
      query: Record<string, string>,
    ): Effect.Effect<A, PeopleError> =>
      Effect.gen(function* () {
        const token = yield* accessToken;
        const response = yield* http
          .execute(
            HttpClientRequest.get(`${BASE_URL}${path}`).pipe(
              HttpClientRequest.bearerToken(token),
              HttpClientRequest.acceptJson,
              HttpClientRequest.appendUrlParams(query),
            ),
          )
          .pipe(
            // NOTE: Tracer propagation off, same as Gmail.ts. With a tracer
            // active the client adds traceparent/b3 headers, and Google's CORS
            // preflight rejects them even though its OPTIONS response claims
            // to allow them. No custom request header may be added here for
            // the same reason.
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
            Effect.mapError(
              (cause) => new PeopleError({ message: String(cause) }),
            ),
          );

        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            new PeopleError({
              message: `People API returned ${response.status}`,
            }),
          );
        }

        return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError(
            (cause) => new PeopleError({ message: String(cause) }),
          ),
        );
      });

    // One endpoint's full walk. Both endpoints page identically and differ
    // only in the field naming, so the caller supplies the extraction.
    const walk = <A>(
      schema: S.Codec<A, any>,
      path: string,
      query: Record<string, string>,
      select: (page: A) => readonly [ReadonlyArray<PersonPhoto>, string],
    ): Effect.Effect<ReadonlyArray<PersonPhoto>, PeopleError> => {
      const step = (
        pageToken: string,
        collected: ReadonlyArray<PersonPhoto>,
      ): Effect.Effect<ReadonlyArray<PersonPhoto>, PeopleError> =>
        Effect.gen(function* () {
          const page = yield* request(schema, path, {
            ...query,
            ...(pageToken === "" ? {} : { pageToken }),
          });
          const [photos, nextPageToken] = select(page);
          const total = [...collected, ...photos];
          return nextPageToken === ""
            ? total
            : yield* step(nextPageToken, total);
        });
      return step("", []);
    };

    /**
     * Every profile photo this account can see, from both halves of the
     * address book.
     *
     * `connections` is the contacts you have saved; `otherContacts` is the
     * people you have only ever exchanged mail with, which for a mailbox is
     * the larger and more useful half — it is what puts a face on the
     * colleague you have never added to a contact list.
     */
    const listPhotos: Effect.Effect<
      ReadonlyArray<PersonPhoto>,
      PeopleError
    > = Effect.gen(function* () {
      const connections = yield* walk(
        ConnectionsResponse,
        "/people/me/connections",
        {
          personFields: "emailAddresses,photos",
          pageSize: String(CONNECTIONS_PAGE_SIZE),
        },
        (page) => [photosOf(page.connections ?? []), page.nextPageToken ?? ""],
      );
      const others = yield* walk(
        OtherContactsResponse,
        "/otherContacts",
        {
          readMask: "emailAddresses,photos",
          pageSize: String(OTHER_CONTACTS_PAGE_SIZE),
        },
        (page) => [
          photosOf(page.otherContacts ?? []),
          page.nextPageToken ?? "",
        ],
      );
      return [...connections, ...others];
    });

    return { listPhotos } as const;
  }),
}) {
  static readonly layer: Layer.Layer<People> = Layer.effect(
    this,
    this.make,
  ).pipe(
    Layer.provide(Layer.mergeAll(AuthClient.layer, FetchHttpClient.layer)),
  );
}
