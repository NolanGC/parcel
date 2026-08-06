// Shared helpers for foldkit's experimental Machine.
//
// Foldkit's Machine.step returns a `TransitionResult` (Transitioned | Ignored)
// so that callers can observe ignored messages. The common case is "collapsed
// step": give me the next state and the commands, and treat Ignored as a no-op.
// This module provides that collapse, and will be a natural home for machine
// utilities as more machines are added.

import { Match as M } from "effect";
import { Command } from "foldkit";
import type {
  Machine,
  Message,
  State,
  Tagged,
} from "foldkit/experimental/machine";

/** Collapse a Machine step's result into `[nextState, commands]`, treating
 *  `Ignored` as a no-op (state unchanged, no commands).
 *
 *  This is the same pattern both syncMachine and outboxMachine repeated.
 *  Now it lives here. */
export const step = <
  S extends Tagged,
  M1 extends Tagged,
  R = never,
>(
  machine: Machine<S, M1, R>,
  state: S,
  message: M1,
): readonly [S, ReadonlyArray<Command.Command<M1, never, R>>] => {
  const result = machine.step(state, message);
  return [
    result.state,
    M.value(result).pipe(
      M.tagsExhaustive({
        Transitioned: ({ commands }) => commands,
        Ignored: () => [],
      }),
    ),
  ];
};

/** Extract the name from a Command (for test assertions on command lists). */
export const commandNames = (
  commands: ReadonlyArray<{ readonly name: string }>,
): ReadonlyArray<string> => commands.map((c) => c.name);

/** Extract a specific command's args by name (for test assertions). */
export const findCommandArgs = <A extends Record<string, unknown>>(
  commands: ReadonlyArray<{ readonly name: string; readonly args?: Record<string, unknown> }>,
  name: string,
): A | undefined =>
  commands.find((c) => c.name === name)?.args as A | undefined;
