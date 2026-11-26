import * as Result from "../shared/result.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Action, DecideState } from "../definition/action.ts";
import type { Decider } from "../pipeline/ruleset.ts";
import type { Args, BindCtx } from "./context.ts";
import { seal, type Decision } from "./seal.ts";
import { inputFailure, validate, type InputFailure } from "./validate.ts";

// 線路を走らせるのに要る部分。判定の線路は、返す値と actor を返す
export type DecideRun<Out, Act, T, A, E> = Pick<
  Decider<DecideState<Out, Act>, { readonly value: T; readonly actor: A }, E, string>,
  "run"
>;

export type DecideMethod<N extends string, In, Out, Act, T, A, E> = (
  args: Args<In, Act>,
) => Result.ResultAsync<Decision<Action<N, In, Out, Act>, T, A>, InputFailure | E>;

export const actionMethods = <N extends string, In, Out, Act, T, A, E>(
  ctx: BindCtx,
  input: StandardSchemaV1<In, Out>,
  rules: DecideRun<Out, Act, T, A, E>,
): { readonly decide: DecideMethod<N, In, Out, Act, T, A, E> } => {
  const decide: DecideMethod<N, In, Out, Act, T, A, E> = async ({ input: value, actor }) => {
    const validated = await validate(input, value);
    if (validated.type === "Failure") return Result.fail(inputFailure(validated.error));
    const inv = ctx.invocation();
    const r = await rules.run({ input: validated.value, actor, now: inv.now }, inv);
    if (r.type === "Failure") return r;
    return Result.succeed(seal<"decision", N, "decide", { readonly value: T; readonly actor: A }>(r.value));
  };
  return Object.freeze({ decide });
};
