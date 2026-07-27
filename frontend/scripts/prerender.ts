import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { resolve } from "node:path";

const RENDER_TIMEOUT_MS = 5000;
const RENDER_POLL_INTERVAL_MS = 25;
const ROOT_PLACEHOLDER = '<div id="root"></div>';

const outdir = process.argv[2];
if (outdir === undefined || outdir === "") {
  throw new Error("Usage: bun scripts/prerender.ts <outdir>");
}
if (process.env.VITE_API_URL === undefined) {
  throw new Error(
    "VITE_API_URL must be set: app modules read it at import time.",
  );
}

const indexPath = resolve(outdir, "index.html");
const baseHtml = await Bun.file(indexPath).text();
if (!baseHtml.includes(ROOT_PLACEHOLDER)) {
  throw new Error(`${indexPath} does not contain ${ROOT_PLACEHOLDER}.`);
}

GlobalRegistrator.register({ url: "http://localhost/" });

const [{ Runtime }, { Layer }, main, auth, sync, search] = await Promise.all([
  import("foldkit"),
  import("effect"),
  import("../src/main"),
  import("../src/auth"),
  import("../src/sync"),
  import("../src/search"),
]);

// The application's resource layer is all-or-nothing at the type level, but
// the landing page is logged out: the only Command init issues at "/" is
// CheckSession, which needs AuthClient and nothing else. SyncEngine and
// Search both build a SQLite worker over OPFS, which does not exist under
// happy-dom, so providing the real layers here either dies in the migrations
// or hangs waiting for a worker that never boots.
//
// AuthClient and the session store are real (both are safe outside a browser:
// one constructs a fetch wrapper, the other reads happy-dom's localStorage).
// The two database services are stubs that throw on any access, so if a
// future landing page starts reading the local store this fails loudly here
// instead of quietly prerendering an empty shell.
const unreachable = <Service extends object>(name: string): Service =>
  new Proxy({} as Service, {
    get: (_target, property) => {
      throw new Error(
        `Prerendering "/" reached ${name}.${String(property)}, which has no local database under happy-dom.`,
      );
    },
  });

const container = document.createElement("div");
container.id = "root";
document.body.appendChild(container);

Runtime.run(
  Runtime.makeApplication({
    Model: main.Model,
    Flags: main.Flags,
    flags: main.flags,
    init: main.init,
    update: main.update,
    view: main.view,
    subscriptions: main.subscriptions,
    managedResources: main.managedResources,
    resources: Layer.mergeAll(
      auth.AuthClient.layer,
      auth.sessionStorageLayer,
      Layer.succeed(sync.SyncEngine, unreachable("SyncEngine")),
      Layer.succeed(search.Search, unreachable("Search")),
    ),
    container,
    routing: {
      onUrlRequest: (request) => main.ClickedLink({ request }),
      onUrlChange: (url) => main.ChangedUrl({ url }),
    },
  }),
);

const waitForRenderedRoot = async (): Promise<Element> => {
  const startedAt = Date.now();
  while (true) {
    const firstElement = document.body.firstElementChild;
    if (
      firstElement !== null &&
      firstElement.id !== "root" &&
      firstElement.children.length > 0
    ) {
      return firstElement;
    }
    if (Date.now() - startedAt > RENDER_TIMEOUT_MS) {
      throw new Error("Timed out waiting for the landing page to render.");
    }
    await new Promise((done) => setTimeout(done, RENDER_POLL_INTERVAL_MS));
  }
};

const renderedHtml = (await waitForRenderedRoot()).outerHTML;

await Bun.write(
  indexPath,
  baseHtml.replace(ROOT_PLACEHOLDER, `<div id="root">${renderedHtml}</div>`),
);

console.log(`Prerendered / into ${indexPath}`);
process.exit(0);
