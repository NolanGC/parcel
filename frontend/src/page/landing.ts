import { html, type Html } from "foldkit/html";

import { APP_NAME } from "../config";
import { homeRouter, inboxRouter, loginRouter } from "../route";

// The public pages: the marketing landing and the 404. No model, no messages,
// nothing to update. Generic in the caller's message type because the landing
// page's one interaction (sign out) belongs to main.ts, and importing it back
// would close a cycle.

export const landingView = <Message>(
  isLoggedIn: boolean,
  signOut: Message,
): Html => {
  const h = html<Message>();

  return h.main(
    [h.Class("min-h-screen bg-neutral-950 px-6 py-24 text-neutral-100")],
    [
      h.div(
        [h.Class("mx-auto max-w-xl")],
        [
          h.h1([h.Class("text-3xl font-bold")], [APP_NAME]),
          h.p(
            [h.Class("mt-3 text-neutral-400")],
            [
              "A fast, keyboard-first email client for your Gmail. Sign in with Google and your inbox is ready — nothing to configure.",
            ],
          ),
          h.a(
            [
              h.Href(isLoggedIn ? inboxRouter() : loginRouter()),
              h.Class("mt-8 inline-block underline underline-offset-4"),
            ],
            [isLoggedIn ? "Open your inbox →" : "Sign in with Google →"],
          ),
          isLoggedIn
            ? h.button(
                [
                  h.Type("button"),
                  h.OnClick(signOut),
                  h.Class(
                    "mt-6 block text-sm text-neutral-400 underline underline-offset-4 hover:text-neutral-200",
                  ),
                ],
                ["Sign out"],
              )
            : h.empty,
        ],
      ),
    ],
  );
};

export const notFoundView = <Message>(path: string): Html => {
  const h = html<Message>();

  return h.div(
    [h.Class("min-h-screen bg-neutral-950 text-neutral-100")],
    [
      h.section(
        [h.Class("mx-auto max-w-5xl px-4 py-10")],
        [
          h.div(
            [h.Class("border border-neutral-800 bg-neutral-900 p-4")],
            [
              h.h1([h.Class("text-2xl font-bold")], ["Page not found"]),
              h.p(
                [h.Class("mt-2 text-neutral-400")],
                [`No route for ${path}.`],
              ),
              h.a(
                [
                  h.Href(homeRouter()),
                  h.Class(
                    "mt-4 inline-block border border-neutral-700 bg-neutral-800 px-4 py-2 font-medium text-neutral-100 hover:bg-neutral-700",
                  ),
                ],
                ["Back home"],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};
