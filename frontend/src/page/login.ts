import { Match as M, Option, Schema as S } from "effect";
import { Command, Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { evo } from "foldkit/struct";

import {
  AuthClient,
  FailedAuth,
  SignInWithGoogle,
  StartedGoogleRedirect,
} from "../auth";

// The sign-in page as a page submodel: a single "Continue with Google"
// button that starts the OAuth round-trip. There is no local success
// transition — the flow leaves the page entirely and the returning visit's
// boot-time `CheckSession` performs the logged-in switch — so the submodel
// only tracks the in-flight state and any error starting (or, via the
// ?error= callback param surfaced through `init`, finishing) the flow.

// MODEL

export const Model = S.Struct({
  pending: S.Boolean,
  error: S.Option(S.String),
  // True while the boot-time `CheckSession` is still in flight and the
  // localStorage cache was empty — the button waits so a valid cookie
  // doesn't flash the page before logging in. Driven by the parent (it owns
  // the session check) via `setCheckingSession`.
  checkingSession: S.Boolean,
});
export type Model = typeof Model.Type;

export const init = (
  checkingSession: boolean,
  error: Option.Option<string> = Option.none(),
): Model => ({
  pending: false,
  error,
  checkingSession,
});

export const setCheckingSession = (
  model: Model,
  checkingSession: boolean,
): Model => evo(model, { checkingSession: () => checkingSession });

// MESSAGE

export const ClickedGoogleSignIn = m("ClickedGoogleSignIn");

export const Message = S.Union([
  ClickedGoogleSignIn,
  // Results of the SignInWithGoogle command issued below. The redirect
  // unloads the page, so `StartedGoogleRedirect` is a formality.
  StartedGoogleRedirect,
  FailedAuth,
]);
export type Message = typeof Message.Type;

// UPDATE

type UpdateReturn = readonly [
  Model,
  ReadonlyArray<Command.Command<Message, never, AuthClient>>,
];

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ClickedGoogleSignIn: () =>
        model.pending
          ? [model, []]
          : [
              evo(model, { pending: () => true, error: () => Option.none() }),
              [SignInWithGoogle()],
            ],
      StartedGoogleRedirect: () => [model, []],
      FailedAuth: ({ error }) => [
        evo(model, {
          pending: () => false,
          error: () => Option.some(error),
        }),
        [],
      ],
    }),
  );

// VIEW

export const view = Submodel.defineView<Model, Message>((model): Html => {
  const h = html<Message>();
  const disabled = model.pending || model.checkingSession;

  return h.main(
    [h.Class("min-h-screen bg-neutral-950 px-6 py-24 text-neutral-100")],
    [
      h.div(
        [h.Class("mx-auto max-w-sm")],
        [
          h.h1([h.Class("text-2xl font-bold")], ["Sign in"]),
          h.p(
            [h.Class("mt-3 text-neutral-400")],
            ["Use your Google account to sign in or create an account."],
          ),
          h.button(
            [
              h.Type("button"),
              h.OnClick(ClickedGoogleSignIn()),
              h.Disabled(disabled),
              h.Class(
                "mt-8 w-full border border-neutral-700 bg-neutral-800 px-4 py-3 font-medium text-neutral-100 hover:bg-neutral-700 disabled:opacity-50",
              ),
            ],
            [
              model.checkingSession
                ? "Checking session…"
                : model.pending
                  ? "Redirecting to Google…"
                  : "Continue with Google",
            ],
          ),
          Option.match(model.error, {
            onNone: () => h.empty,
            onSome: (error) =>
              h.p(
                [h.Class("mt-4 text-sm text-red-400"), h.Role("alert")],
                [error],
              ),
          }),
        ],
      ),
    ],
  );
});
