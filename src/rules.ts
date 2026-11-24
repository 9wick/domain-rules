import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Action, Actor, DecideState, DeleteState, Model, Persisted, SaveStates, Value } from "./model.ts";
import type { Port, PortArgs, PortError, PortValue } from "./port.ts";
import type { Decider, PlannedRule, RulesetOut, RunnableRuleset, RulesetPorts } from "./ruleset.ts";

export type InputFailure = {
  readonly step: "input";
  readonly error: { readonly issues: readonly StandardSchemaV1.Issue[] };
};
export type LoadFailure<L> = { readonly step: "load"; readonly error: "NOT_FOUND" | PortError<L> };

type AnyLoad = Port<string, readonly [unknown]>;
export type Existing<L> = [L] extends [never] ? never : Exclude<PortValue<L>, null>;
type LoadId<M extends Model> = "id" extends keyof Value<M> ? Exclude<Value<M>["id"], undefined> : never;
type LoadIdMismatch<M extends Model, L> = [LoadId<M>] extends [never]
  ? { readonly "load には入力スキーマの id が要る": true }
  : [LoadId<M>] extends [PortArgs<L>[0]]
    ? unknown
    : { readonly "load が検証済みの id を受け取れない": LoadId<M> };

type LoadMismatch<M extends Model, L> = [L] extends [never]
  ? unknown
  : [PortValue<L>] extends [Persisted<M> | null]
    ? LoadIdMismatch<M, L>
    : { readonly "load の返り値が永続化の型に代入できない": PortValue<L> };

type SaveStart<M extends Model, L> = SaveStates<Existing<L>, Value<M>>;
type DeleteStart<L> = DeleteState<Existing<L>>;

// 線路は開始の状態に値を重ねていくので、最後の状態は開始の状態と線路が重ねた型の交差型になる
export type SaveEnd<M extends Model, L, Save> = SaveStart<M, L> & RulesetOut<Save>;
export type DeleteEnd<L, Del> = DeleteStart<L> & RulesetOut<Del>;

// 保存の線路の最後の状態は、next が永続化の型になっていなければならない
type PersistedGuard<M extends Model, End> = [End] extends [never]
  ? unknown
  : [End] extends [{ readonly next: Persisted<M> }]
    ? unknown
    : { readonly "最後の next が永続化の型にならない": End extends { readonly next: infer X } ? X : never };

export type AnyRunnable = RunnableRuleset<never, unknown, unknown, string>;
export type AnyDecider = Decider<never, unknown, unknown, string>;

export type ModelRules<
  M extends Model = Model,
  L extends AnyLoad = AnyLoad,
  Save extends AnyRunnable | undefined = AnyRunnable | undefined,
  Del extends AnyRunnable | undefined = AnyRunnable | undefined,
> = {
  readonly kind: "modelRules";
  readonly name: M["name"];
  readonly model: M;
  readonly load: L | undefined;
  readonly save: Save | undefined;
  readonly delete: Del | undefined;
};

export function modelRules<
  M extends Model,
  L extends AnyLoad = never,
  Save extends RunnableRuleset<SaveStart<M, NoInfer<L>>, unknown, unknown, string> | undefined = undefined,
  Del extends RunnableRuleset<DeleteStart<NoInfer<L>>, unknown, unknown, string> | undefined = undefined,
>(
  m: M,
  def: {
    readonly load?: L & LoadMismatch<M, L>;
    readonly save?: Save & PersistedGuard<M, SaveEnd<M, NoInfer<L>, NoInfer<Save>>>;
    readonly delete?: Del & ([L] extends [never] ? { readonly "delete には load が要る": true } : unknown);
  },
): ModelRules<M, NoInfer<L>, NoInfer<Save>, NoInfer<Del>> {
  const set: ModelRules<M, L, Save, Del> = {
    kind: "modelRules",
    name: m.name,
    model: m,
    load: def.load,
    save: def.save,
    delete: def.delete,
  };
  return Object.freeze(set);
}

export type ActionRules<A extends Action = Action, Rs extends AnyDecider = AnyDecider> = {
  readonly kind: "actionRules";
  readonly name: A["name"];
  readonly action: A;
  readonly rules: Rs;
};

type DecideStart<A extends Action> = DecideState<StandardSchemaV1.InferOutput<A["input"]>>;
type Decided<End extends { readonly actor: unknown }, T> = { readonly value: T; readonly actor: End["actor"] };

const actorOf = <X extends { readonly actor: unknown }>(x: X): X["actor"] => x.actor;

// output は線路の最後の step で、最後の状態から返す値を組み立てる
export function actionRules<A extends Action, D, E, PN extends string, T>(
  a: A,
  def: {
    readonly rules: RunnableRuleset<DecideStart<A>, D, E, PN>;
    readonly output: (s: DecideStart<A> & D) => T;
  },
): ActionRules<A, Decider<DecideStart<A>, Decided<DecideStart<A> & D, T>, E, PN>> {
  const { rules, output } = def;
  const decided: Decider<DecideStart<A>, Decided<DecideStart<A> & D, T>, E, PN> = {
    ...rules,
    run: async (s, call) => {
      const r = await rules.run(s, call);
      return Result.isFailure(r) ? r : Result.succeed({ value: output(r.value), actor: actorOf(r.value) });
    },
  };
  return Object.freeze({ kind: "actionRules", name: a.name, action: a, rules: Object.freeze(decided) });
}

export type RuleSet = ModelRules | ActionRules;

export type RuleSetPorts<S> =
  S extends ModelRules<Model, infer L, infer Save, infer Del>
    ? ([L] extends [never] ? never : L["name"]) | RulesetPorts<Save> | RulesetPorts<Del>
    : S extends ActionRules<Action, infer Rs>
      ? RulesetPorts<Rs>
      : never;

export function plan(set: ModelRules): {
  readonly save?: readonly PlannedRule[];
  readonly delete?: readonly PlannedRule[];
};
export function plan(set: ActionRules): { readonly rules: readonly PlannedRule[] };
export function plan(set: RuleSet) {
  if (set.kind === "actionRules") return { rules: set.rules.plan };
  return {
    ...(set.save && { save: set.save.plan }),
    ...(set.delete && { delete: set.delete.plan }),
  };
}

export type { Actor };
