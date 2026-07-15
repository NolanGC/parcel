# parcel

A full-stack starter (simple CRUD todo list) that combines
[Foldkit](https://foldkit.dev) and [Alchemy](https://alchemy.run) for building
apps end-to-end with Effect, running on Cloudflare with Postgres
(PlanetScale) via Hyperdrive.

## Setup

```sh
bun install
cp .env.example .env  # then fill in the PlanetScale values
bun dev
```

That's it — `bun dev` prompts a Cloudflare login (OAuth) on first run and
provisions everything else (Postgres branch, Hyperdrive, workers)
automatically.

Postgres is provided through the `Postgres` service in `backend/src/Db.ts`;
everything else depends on that service, never on the provider directly.

## Structure

```txt
alchemy.run.ts        # shared Alchemy stack
backend/src/          # Effect HTTP API, Worker service, Drizzle schema
frontend/src/         # Foldkit app and Foldkit tests
migrations/           # Drizzle migrations, applied on deploy
test/                 # integration test (deploys real infrastructure)
```

> The first `bun dev` (or deploy) generates the initial Drizzle migration
> into `migrations/` — commit it.

## Scripts

| Script                   | What it does                                     |
| ------------------------ | ------------------------------------------------ |
| `bun dev`                | Run the whole stack locally                      |
| `bun run deploy`         | Deploy the `production` stage                    |
| `bun run destroy`        | Tear the deployed stage down                     |
| `bun run dev:branch`     | Dev against a stage named after your git branch  |
| `bun run deploy:branch`  | Deploy a stage named after your git branch       |
| `bun run destroy:branch` | Destroy that branch stage                        |
| `bun run test`           | Frontend (Foldkit) tests                         |
| `bun run test:integ`     | Integration tests (deploys real infrastructure!) |
| `bun run build`          | Typecheck                                        |
| `bun run lint`           | Lint (oxlint)                                    |
| `bun run format`         | Format (oxfmt)                                   |

## Desktop app

`packages/desktop` is a [Tauri](https://tauri.app) shell around the same
frontend — no duplicated UI code. It needs a
[Rust toolchain](https://rustup.rs) installed.

### Develop

With `bun dev` running in another terminal:

```sh
bun run dev:desktop
```

opens the app in a native window against the local stack, hot reload
included (the window loads the same Vite dev server as the browser).

### Build and distribute

The desktop app isn't deployed — it's built against a deployed stage and
handed to users. The API URL is baked in at build time:

```sh
bun run deploy   # make sure the stage is live first
VITE_API_URL=<the deployed API URL printed by deploy> bun run build:desktop
```

Native bundles land in `packages/desktop/src-tauri/target/release/bundle/`
(on macOS: a `.app` and `.dmg`). Distribute those however you like, e.g.
attach them to a GitHub Release. Tauri can't cross-compile, so building for
all three platforms takes a CI matrix (macOS/Windows/Linux runners).

Two things to know before shipping to real users:

- The frontend is bundled statically: backend deploys reach desktop users
  immediately (the app is just an API client), but UI changes only ship with
  a new binary. Wire up [Tauri's updater
  plugin](https://tauri.app/plugin/updater/) for self-updates.
- macOS refuses unsigned apps downloaded from the internet — signing and
  notarization need an Apple Developer ID (Tauri has [built-in
  config](https://tauri.app/distribute/sign/macos/) for both).

## Cloud deploys

Deploys need `CLOUDFLARE_WORKERS_SUBDOMAIN` in `.env` — your account's
`workers.dev` subdomain, shown by `wrangler whoami`. See `.env.example` for
every variable this app reads.

## Deployment state

Deployment state lives in `.alchemy/` on disk (gitignored) — nothing
to configure, but it only knows what *this* checkout has deployed. Deleting
the folder or cloning it fresh elsewhere loses track of what's live; you'd
need to destroy the old deployment manually (Cloudflare / Neon / PlanetScale
dashboards) before it becomes an orphaned, still-billing resource. Switch to
`Cloudflare.state()` in `alchemy.run.ts` if you need to resume deploys
from another machine or a team needs to share one.

## Integration tests

`bun run test:integ` deploys a disposable copy of the whole stack (Postgres
branch, migrations, Hyperdrive, both workers) to real Cloudflare and
PlanetScale infrastructure, runs API-level tests against it, and destroys
it afterwards. It needs the same credentials as a cloud deploy: the
PlanetScale variables from `.env.example`, `CLOUDFLARE_WORKERS_SUBDOMAIN`,
and a Cloudflare login (`wrangler` OAuth, or `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` in CI). Each run costs real deploy/destroy cycles;
nothing runs unless you invoke it explicitly.
# parcel
