/// <reference lib="webworker" />
import { Effect } from "effect";
import { OpfsWorker } from "@effect/sql-sqlite-wasm";

Effect.runFork(OpfsWorker.run({ port: self, dbName: "sync.sqlite" }));
