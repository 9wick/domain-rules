import * as Result from "../shared/result.ts";
import type { Action, DecideState } from "../definition/action.ts";
import { actionMethods, type DecideMethod, type DecideRun } from "../method/action-method.ts";
import type { BindCtx } from "../method/context.ts";
import type { PlannedRule, portNames, RunnableRuleset } from "../pipeline/ruleset.ts";
import type { AnyPort } from "../port/port.ts";

export type ActionPlan = { readonly rules: readonly PlannedRule[] };

// bind に渡せる action の rule の組。model の rule の組と同じ項目を持ち、bind は kind で読み分けない
export class ActionRules<N extends string = string, PN extends string = string, Ms = unknown> {
  declare readonly [portNames]: PN;
  readonly kind = "actionRules";
  readonly name: N;
  readonly plan: ActionPlan;
  readonly ports: readonly AnyPort[];
  readonly resolveIn: (ctx: BindCtx) => Ms;

  constructor(name: N, plan: ActionPlan, ports: readonly AnyPort[], resolveIn: (ctx: BindCtx) => Ms) {
    this.name = name;
    this.plan = plan;
    this.ports = ports;
    this.resolveIn = resolveIn;
    Object.freeze(this);
  }
}

const actorOf = <X extends { readonly actor: unknown }>(x: X): X["actor"] => x.actor;

// output は線路の最後の step で、最後の状態から返す値を組み立てる
export function actionRules<N extends string, In, Out, Act, D, E, PN extends string, T, Ev = never>(
  a: Action<N, In, Out, Act>,
  def: {
    readonly rules: RunnableRuleset<DecideState<Out, Act>, D, E, PN, Ev>;
    readonly output: (s: DecideState<Out, Act> & D) => T;
  },
): ActionRules<
  N,
  PN,
  { readonly decide: DecideMethod<N, In, Out, Act, T, (DecideState<Out, Act> & D)["actor"], E, Ev> }
> {
  const { rules, output } = def;
  const decided: DecideRun<Out, Act, T, (DecideState<Out, Act> & D)["actor"], E, Ev> = {
    run: async (s, call) => {
      const r = await rules.run(s, call);
      if (r.type === "Failure") return r;
      const { state, events } = r.value;
      return Result.succeed({ decided: { value: output(state), actor: actorOf(state) }, events });
    },
  };
  return new ActionRules(a.name, { rules: rules.plan }, rules.ports, (ctx: BindCtx) =>
    actionMethods<N, In, Out, Act, T, (DecideState<Out, Act> & D)["actor"], E, Ev>(ctx, a.input, decided),
  );
}
