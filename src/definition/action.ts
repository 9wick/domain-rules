import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Actor } from "./actor.ts";
import { Track } from "./track.ts";

export type Action<N extends string = string, In = unknown, Out = unknown> = {
  readonly kind: "action";
  readonly name: N;
  readonly input: StandardSchemaV1<In, Out>;
  readonly onDecide: Track<"decide", N, DecideState<Out>>;
};

export type DecideState<I> = { readonly input: I; readonly actor: Actor; readonly now: number };

export const action = <const N extends string, In, Out>(def: {
  readonly name: N;
  readonly input: StandardSchemaV1<In, Out>;
}): Action<N, In, Out> =>
  Object.freeze({
    kind: "action",
    name: def.name,
    input: def.input,
    onDecide: new Track<"decide", N, DecideState<Out>>("decide", def.name),
  });
