// BetterAuth tables live in auth-schema.ts; re-exported so drizzle-kit (and
// alchemy's Drizzle.Schema) see the whole database through this one module.
// App tables (mail metadata, sync state, …) will join them here.
export * from "./auth-schema.ts";
