/// <reference lib="webworker" />
import { Effect } from "effect";
import { OpfsWorker } from "@effect/sql-sqlite-wasm";

// dbName bumped when the schema changed incompatibly (bodies went from
// gzip blobs to plain text); the old sync.sqlite is simply abandoned.
Effect.runFork(OpfsWorker.run({ port: self, dbName: "parcel.sqlite" }));
