import { Runtime } from "foldkit";

import { overlay } from "@foldkit/devtools";

import { authClientLayer } from "./auth";
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
  resources: authClientLayer,
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
