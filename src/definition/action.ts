import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Track } from "./track.ts";

export type Action<N extends string = string, In = unknown, Out = unknown, Act = unknown> = {
  readonly kind: "action";
  readonly name: N;
  readonly input: StandardSchemaV1<In, Out>;
  readonly onDecide: Track<"decide", N, DecideState<Out, Act>>;
};

export type DecideState<I, Act> = { readonly input: I; readonly actor: Act; readonly now: number };

// action を作った domain の actor の型
export type ActionActor<A extends Action> =
  A["onDecide"] extends Track<"decide", string, DecideState<unknown, infer X>> ? X : never;

// actor の型を決めてから action を作る。actor の型は domain で1回だけ書く
export const defineAction =
  <Act>() =>
  <const N extends string, In, Out>(def: {
    readonly name: N;
    readonly input: StandardSchemaV1<In, Out>;
  }): Action<N, In, Out, Act> =>
    Object.freeze({
      kind: "action",
      name: def.name,
      input: def.input,
      onDecide: new Track<"decide", N, DecideState<Out, Act>>("decide", def.name),
    });
