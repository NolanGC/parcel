// App-level configuration as an Effect service.
//
// The old module-level constant threw at import time when VITE_API_URL was
// absent, which made every transitively-importing module fail during test
// setup. Reading it lazily inside the service `make` defers the check to
// Layer build — modules stay importable, and only building the live layer
// (entry.ts / a test that needs the URL) surfaces a missing value.

import { Context, Effect, Layer } from "effect";

export const APP_NAME = "parcel";

// SERVICE
//
// The API base URL, read from `import.meta.env` at Layer build. A missing
// value is a wiring bug (Alchemy always injects it), so the make effect
// dies — but lazily, not at import.

export class ApiUrl extends Context.Service<ApiUrl, string>()("parcel/ApiUrl", {
  make: Effect.sync(() => {
    const url: string | undefined = import.meta.env.VITE_API_URL;
    if (url === undefined) {
      throw new Error("VITE_API_URL is not set.");
    }
    return url;
  }),
}) {}

export const LiveApiUrl: Layer.Layer<ApiUrl> = Layer.effect(
  ApiUrl,
  ApiUrl.make,
);
