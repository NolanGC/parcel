/// <reference lib="webworker" />
import { Effect } from "effect";
import { OpfsWorker } from "@effect/sql-sqlite-wasm";

const DB_NAME = "parcel.sqlite";

Effect.runFork(OpfsWorker.run({ port: self, dbName: DB_NAME }));
