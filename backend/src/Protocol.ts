import * as S from "effect/Schema";

// Branded id: user ids are strings on the wire, so without the brand a
// swapped argument compiles and mis-routes at runtime.
export const UserId = S.NonEmptyString.pipe(S.brand("UserId"));
export type UserId = typeof UserId.Type;
