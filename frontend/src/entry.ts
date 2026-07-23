import { Layer } from "effect";
import { Runtime } from "foldkit";

import { overlay } from "@foldkit/devtools";

import { AuthClient, sessionStorageLayer } from "./auth";
import { SyncEngine } from "./sync";
import {
  ChangedUrl,
  ClickedLink,
  Flags,
  Model,
  Message,
  flags,
  init,
  managedResources,
  subscriptions,
  update,
  view,
} from "./main";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  Flags,
  flags,
  init,
  update,
  view,
  subscriptions,
  managedResources,
  // orDie: resources must be a never-failing layer, and SyncEngine's
  // build runs the local database migrations — if those fail the app has
  // no working store, so dying (crash screen) is the honest outcome.
  resources: Layer.mergeAll(
    AuthClient.layer,
    sessionStorageLayer,
    Layer.orDie(SyncEngine.layer),
  ),
  container: document.getElementById("root"),
  routing: {
    onUrlRequest: (request) => ClickedLink({ request }),
    onUrlChange: (url) => ChangedUrl({ url }),
  },
  devTools: {
    overlay,
    Message,
  },
});

Runtime.run(application);
