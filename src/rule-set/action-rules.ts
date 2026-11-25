import { Result } from "@praha/byethrow";
import type { Action, DecideState } from "../definition/action.ts";
import { actionMethods, type DecideMethod } from "../method/action-method.ts";
import type { BindCtx } from "../method/context.ts";
import type { Decider, RunnableRuleset } from "../pipeline/ruleset.ts";

export type AnyDecider = Decider<never, unknown, unknown, string>;

export type ActionRules<A extends Action = Action, Rs extends AnyDecider = AnyDecider, Ms = unknown> = {
  readonly kind: "actionRules";
  readonly name: A["name"];
  readonly action: A;
  readonly rules: Rs;
  readonly resolveIn: (ctx: BindCtx) => Ms;
};

type Decided<End extends { readonly actor: unknown }, T> = { readonly value: T; readonly actor: End["actor"] };

const actorOf = <X extends { readonly actor: unknown }>(x: X): X["actor"] => x.actor;

// output は線路の最後の step で、最後の状態から返す値を組み立てる
export function actionRules<N extends string, In, Out, D, E, PN extends string, T>(
  a: Action<N, In, Out>,
  def: {
    readonly rules: RunnableRuleset<DecideState<Out>, D, E, PN>;
    readonly output: (s: DecideState<Out> & D) => T;
  },
): ActionRules<
  Action<N, In, Out>,
  Decider<DecideState<Out>, Decided<DecideState<Out> & D, T>, E, PN>,
  { readonly decide: DecideMethod<N, In, Out, T, (DecideState<Out> & D)["actor"], E> }
> {
  const { rules, output } = def;
  const decided: Decider<DecideState<Out>, Decided<DecideState<Out> & D, T>, E, PN> = {
    ...rules,
    run: async (s, call) => {
      const r = await rules.run(s, call);
      return Result.isFailure(r) ? r : Result.succeed({ value: output(r.value), actor: actorOf(r.value) });
    },
  };
  return Object.freeze({
    kind: "actionRules",
    name: a.name,
    action: a,
    rules: Object.freeze(decided),
    resolveIn: (ctx: BindCtx) =>
      actionMethods<N, In, Out, T, (DecideState<Out> & D)["actor"], E>(ctx, a.input, decided),
  });
}
