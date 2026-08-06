// END-TO-END Effect test of the sync service graph.
//
// Unlike the pure step tests (syncMachine.test.ts) — which hand the machine
// messages and inspect the commands it issues — this test actually RUNS the
// machine's Commands through the Effect service graph. The SyncEngine service
// is replaced with a scripted fake (services/test/FakeSyncEngine.ts), the
// Policy service is live, and the full checkpoint → prime → backfill →
// history → settle lifecycle is driven by *executing* the real command
// Effects and feeding their real Messages back into the machine.
//
// This is the "service graph" proof: commands declare their service deps in
// R, the graph supplies them, and the machine drives the whole thing.

import { Effect, Layer, Option } from "effect";
import { describe, expect, test } from "vitest";
import { HistoryId, PageToken } from "./Gmail";
import { LivePolicy, Policy } from "./services/policy";
import {
  FakeSyncEngineLayer,
  type SyncScript,
  defaultScript,
} from "./services/test/FakeSyncEngine";
import { SyncEngine } from "./sync";
import * as SyncMachine from "./syncMachine";

/** The test graph: a scripted SyncEngine + the live Policy. */
const testLayer = (script?: SyncScript): Layer.Layer<SyncEngine | Policy> =>
  Layer.mergeAll(FakeSyncEngineLayer(script), LivePolicy);

/** Execute one command's effect against the graph, returning its Message. */
const execute = <A>(
  cmd: { readonly effect: Effect.Effect<A, never, SyncEngine> },
  layer: Layer.Layer<SyncEngine | Policy>,
): A => Effect.runSync(cmd.effect.pipe(Effect.provide(layer)));

describe("sync service graph — end to end", () => {
  test("a cold store runs checkpoint → prime → backfill → diff → settle", () => {
    // Scrip the engine: no checkpoint (cold), one prime, one exhausted
    // batch page, and an Applied history diff.
    const script: SyncScript = {
      checkpoint: Option.none(),
      prime: {
        historyId: HistoryId.make("h-prime"),
        syncedCount: 1,
        totalEstimate: 3,
      },
      batches: [{ syncedCount: 3, maybeNextPageToken: Option.none() }],
      history: { _tag: "Applied", historyId: HistoryId.make("h-100"), changedCount: 2, syncedAt: 1000 },
    };
    const layer = testLayer(script);

    // 1. boot: read the checkpoint
    const checkpointMsg = execute(
      SyncMachine.ReadSyncCheckpoint({ accountEmail: "ada@example.com" }),
      layer,
    );
    expect(checkpointMsg._tag).toBe("SucceededReadSyncCheckpoint");

    let [state, commands] = SyncMachine.step(
      SyncMachine.init(),
      checkpointMsg,
    );
    expect(state._tag).toBe("Priming");
    expect(commands.map((c) => c.name)).toEqual(["PrimeInbox"]);

    // 2. prime the inbox
    const primeMsg = execute(commands[0]!, layer);
    expect(primeMsg._tag).toBe("CompletedPrimeInbox");
    [state, commands] = SyncMachine.step(state, primeMsg);
    expect(state._tag).toBe("Backfilling");
    expect(commands.map((c) => c.name)).toEqual(["SyncBatch"]);

    // 3. walk the (single) backfill page
    const batchMsg = execute(commands[0]!, layer);
    expect(batchMsg._tag).toBe("CompletedSyncBatch");
    [state, commands] = SyncMachine.step(state, batchMsg);
    // exhausted → hand off to the history diff
    expect(state._tag).toBe("CatchingUp");
    expect(commands.map((c) => c.name)).toEqual(["ApplyHistory"]);

    // 4. apply the incremental history diff → settle
    const historyMsg = execute(commands[0]!, layer);
    expect(historyMsg._tag).toBe("AppliedHistory");
    [state, commands] = SyncMachine.step(state, historyMsg);
    expect(state._tag).toBe("Settled");
    expect(commands.map((c) => c.name)).toEqual(["WaitPoll"]);

    // The whole cold→settled lifecycle ran through real Effect services.
    if (state._tag === "Settled") {
      expect(state.historyId).toBe(HistoryId.make("h-100"));
    }
  });

  test("a resumable checkpoint skips priming and resumes the backfill", () => {
    const script: SyncScript = {
      checkpoint: Option.some({
        maybeHistoryId: Option.some(HistoryId.make("h-old")),
        isBackfillDone: false,
        syncedCount: 4000,
        totalEstimate: 10000,
      }),
      prime: defaultScript().prime,
      batches: [{ syncedCount: 4100, maybeNextPageToken: Option.none() }],
      history: defaultScript().history,
    };
    const layer = testLayer(script);

    const checkpointMsg = execute(
      SyncMachine.ReadSyncCheckpoint({ accountEmail: "ada@example.com" }),
      layer,
    );
    expect(checkpointMsg._tag).toBe("SucceededReadSyncCheckpoint");

    const [state, commands] = SyncMachine.step(SyncMachine.init(), checkpointMsg);
    // Mid-backfill checkpoint → straight to Backfilling, no prime.
    expect(state._tag).toBe("Backfilling");
    expect(commands.map((c) => c.name)).toEqual(["SyncBatch"]);
    if (state._tag === "Backfilling") {
      expect(state.syncedCount).toBe(4000);
    }
  });

  test("an expired history diff triggers a full resync from Priming", () => {
    const script: SyncScript = {
      checkpoint: Option.none(),
      prime: defaultScript().prime,
      batches: [{ syncedCount: 3, maybeNextPageToken: Option.none() }],
      history: { _tag: "Expired" },
    };
    const layer = testLayer(script);

    const checkpointMsg = execute(
      SyncMachine.ReadSyncCheckpoint({ accountEmail: "ada@example.com" }),
      layer,
    );
    let [state, commands] = SyncMachine.step(SyncMachine.init(), checkpointMsg);
    const primeMsg = execute(commands[0]!, layer);
    [state, commands] = SyncMachine.step(state, primeMsg);
    const batchMsg = execute(commands[0]!, layer);
    [state, commands] = SyncMachine.step(state, batchMsg);
    const historyMsg = execute(commands[0]!, layer);

    // Expired → full resync: back to Priming.
    [state, commands] = SyncMachine.step(state, historyMsg);
    expect(state._tag).toBe("Priming");
    expect(commands.map((c) => c.name)).toEqual(["PrimeInbox"]);
  });
})
