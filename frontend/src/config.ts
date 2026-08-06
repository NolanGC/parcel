// App-level configuration as Effect services.
//
// NOT a module-level constant that throws at import time (the old approach),
// because every module transitively importing it would fail during test
// setup when VITE_API_URL isn't injected. A Context service defers the
// read to the Layer boundary, keeping all modules testable.

import { Context, Effect, Layer } from "effect";

export const APP_NAME = "parcel";

// SERVICE TAG

export class ApiUrl extends Context.Reference<ApiUrl>()("parcel/ApiUrl") {}

// LIVE LAYER

const envUrl: string | undefined = import.meta.env.VITE_API_URL;

export const LiveApiUrl: Layer.Layer<ApiUrl> =
  envUrl === undefined
    ? Layer.dieMessage("VITE_API_URL is not set.")
    : Layer.succeed(ApiUrl, envUrl);
