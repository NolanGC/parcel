import { Match as M, Option, Schema as S } from "effect";
import { Command, Submodel } from "foldkit";
import { html, type Html } from "foldkit/html";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";
import { evo } from "foldkit/struct";

import {
  AuthClient,
  FailedAuth,
  SignInWithGoogle,
  StartedGoogleRedirect,
} from "../auth";

// MODEL

// NOTE: There is no local success transition. The OAuth flow leaves the page
// entirely, and the returning visit's boot-time CheckSession performs the
// logged-in switch, so `Redirecting` is terminal for this submodel.
export const CheckingSession = ts("CheckingSession");
export const Ready = ts("Ready");
export const Redirecting = ts("Redirecting");
export const Status = S.Union([CheckingSession, Ready, Redirecting]);
export type Status = typeof Status.Type;

export const Model = S.Struct({
  status: Status,
  maybeError: S.Option(S.String),
});
export type Model = typeof Model.Type;

export const init = (
  status: Status,
  maybeError: Option.Option<string> = Option.none(),
): Model => ({ status, maybeError });

/** The parent's boot session check came back without a session, so the page
 *  stops waiting on it. */
export const settledSessionCheck = (model: Model): Model =>
  evo(model, {
    status: M.type<Status>().pipe(
      M.tagsExhaustive({
        CheckingSession: () => Ready(),
        Ready: () => Ready(),
        Redirecting: () => Redirecting(),
      }),
    ),
  });

// MESSAGE

export const ClickedGoogleSignIn = m("ClickedGoogleSignIn");

export const Message = S.Union([
  ClickedGoogleSignIn,
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
        M.value(model.status).pipe(
          M.withReturnType<UpdateReturn>(),
          M.tagsExhaustive({
            Ready: () => [
              evo(model, {
                status: () => Redirecting(),
                maybeError: () => Option.none(),
              }),
              [SignInWithGoogle()],
            ],
            CheckingSession: () => [model, []],
            Redirecting: () => [model, []],
          }),
        ),
      StartedGoogleRedirect: () => [model, []],
      FailedAuth: ({ error }) => [
        evo(model, {
          status: () => Ready(),
          maybeError: () => Option.some(error),
        }),
        [],
      ],
    }),
  );

// VIEW

const statusLabel = M.type<Status>().pipe(
  M.tagsExhaustive({
    CheckingSession: () => "Checking session…",
    Ready: () => "Continue with Google",
    Redirecting: () => "Redirecting to Google…",
  }),
);

const isBusy = (status: Status): boolean => status._tag !== "Ready";

export const view = Submodel.defineView<Model, Message>((model): Html => {
  const h = html<Message>();

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
              h.Disabled(isBusy(model.status)),
              h.Class(
                "mt-8 w-full border border-neutral-700 bg-neutral-800 px-4 py-3 font-medium text-neutral-100 hover:bg-neutral-700 disabled:opacity-50",
              ),
            ],
            [statusLabel(model.status)],
          ),
          Option.match(model.maybeError, {
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
