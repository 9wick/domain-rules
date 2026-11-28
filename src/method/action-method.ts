import * as Result from "../shared/result.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Action, DecideState } from "../definition/action.ts";
import type { Invocation } from "../port/invocation.ts";
import type { Args, BindCtx } from "./context.ts";
import { seal, type Decision } from "./seal.ts";
import { inputFailure, validate, type InputFailure } from "./validate.ts";

// 線路を走らせるのに要る部分。判定の線路は、返す値と actor と、発行したイベントを返す
export type DecideRun<Out, Act, T, A, E, Ev> = {
  readonly run: (
    s: DecideState<Out, Act>,
    invocation: Invocation,
  ) => Promise<
    Result.Result<{ readonly decided: { readonly value: T; readonly actor: A }; readonly events: readonly Ev[] }, E>
  >;
};

// メソッドの成功の値。封をした値と、封をしないイベントを並べる
export type Decided<S, Ev> = { readonly decision: S; readonly events: readonly Ev[] };

export type DecideMethod<N extends string, In, Out, Act, T, A, E, Ev> = (
  args: Args<In, Act>,
) => Result.ResultAsync<Decided<Decision<Action<N, In, Out, Act>, T, A>, Ev>, InputFailure | E>;

export const actionMethods = <N extends string, In, Out, Act, T, A, E, Ev>(
  ctx: BindCtx,
  input: StandardSchemaV1<In, Out>,
  rules: DecideRun<Out, Act, T, A, E, Ev>,
): { readonly decide: DecideMethod<N, In, Out, Act, T, A, E, Ev> } => {
  const decide: DecideMethod<N, In, Out, Act, T, A, E, Ev> = async ({ input: value, actor }) => {
    const validated = await validate(input, value);
    if (validated.type === "Failure") return Result.fail(inputFailure(validated.error));
    const inv = ctx.invocation();
    const r = await rules.run({ input: validated.value, actor, now: inv.now }, inv);
    if (r.type === "Failure") return r;
    return Result.succeed({
      decision: seal<"decision", N, "decide", { readonly value: T; readonly actor: A }>(r.value.decided),
      events: Object.freeze([...r.value.events]),
    });
  };
  return Object.freeze({ decide });
};
