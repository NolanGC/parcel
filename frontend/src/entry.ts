import { Runtime } from "foldkit";

import { overlay } from "@foldkit/devtools";

import { AppLayer } from "./services/Graph";
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

// The whole app is one composed service graph (see services/Graph.ts).
// entry.ts is deliberately thin: it feeds the assembled graph to the
// Foldkit runtime and wires routing/devtools around it.
const application = Runtime.makeApplication({
  Model,
  Flags,
  flags,
  init,
  update,
  view,
  subscriptions,
  managedResources,
  resources: AppLayer,
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
