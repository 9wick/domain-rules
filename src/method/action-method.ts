import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Action, DecideState } from "../definition/action.ts";
import type { Decider } from "../pipeline/ruleset.ts";
import type { Args, BindCtx } from "./context.ts";
import { seal, type Decision } from "./seal.ts";
import { inputFailure, validate, type InputFailure } from "./validate.ts";

export type DecideMethod<N extends string, In, Out, T, A, E> = (
  args: Args<In>,
) => Result.ResultAsync<Decision<Action<N, In, Out>, T, A>, InputFailure | E>;

export const actionMethods = <N extends string, In, Out, T, A, E>(
  ctx: BindCtx,
  input: StandardSchemaV1<In, Out>,
  rules: Decider<DecideState<Out>, { readonly value: T; readonly actor: A }, E, string>,
): { readonly decide: DecideMethod<N, In, Out, T, A, E> } => {
  const decide: DecideMethod<N, In, Out, T, A, E> = async ({ input: value, actor }) => {
    const validated = await validate(input, value);
    if (Result.isFailure(validated)) return Result.fail(inputFailure(validated.error));
    const inv = ctx.invocation();
    const r = await rules.run({ input: validated.value, actor, now: inv.now }, inv);
    if (Result.isFailure(r)) return r;
    return Result.succeed(seal<"decision", N, "decide", { readonly value: T; readonly actor: A }>(r.value));
  };
  return Object.freeze({ decide });
};
