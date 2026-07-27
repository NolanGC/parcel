export const APP_NAME = "parcel";

// NOTE: Alchemy always injects VITE_API_URL (see alchemy.run.ts) and builds
// only ever run through Alchemy, so absence is a wiring bug, not a mode.
const url = import.meta.env.VITE_API_URL;
if (url === undefined) {
  throw new Error("VITE_API_URL is not set.");
}
export const API_URL: string = url;
