// The public pages: the marketing landing and the 404. Static content out
// of the SPA bundle — no model, no messages, nothing to update. They live
// here rather than in main.ts because main.ts is the app shell (routing,
// session, subscriptions) and these are just two documents it can render.
//
// Generic in the caller's message type. The landing page's one interaction
// (sign out) is passed in as a message rather than imported, because the
// session belongs to main.ts — importing it back would make this a cycle.

import { html, type Html } from "foldkit/html";

import { homeRouter, inboxRouter, loginRouter } from "../route";

const APP_NAME = "parcel";

// The marketing landing: the only public page besides sign-in. Static
// content served from the SPA bundle.
export const landingView = <Msg,>(
  isLoggedIn: boolean,
  signOut: Msg,
): Html => {
  const h = html<Msg>();

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

export const notFoundView = <Msg,>(
  heading: string,
  detail: string,
): Html => {
  const h = html<Msg>();

  return h.section(
    [h.Class("mx-auto max-w-5xl px-4 py-10")],
    [
      h.div(
        [h.Class("border border-neutral-800 bg-neutral-900 p-4")],
        [
          h.h1([h.Class("text-2xl font-bold")], [heading]),
          h.p([h.Class("mt-2 text-neutral-400")], [detail]),
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
  );
};
