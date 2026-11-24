import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { actionMethods, modelMethods, type BuildMethods } from "./methods.ts";
import type { Action, Actor, DecideState, DeleteState, Model, Persisted, SaveState, Value } from "./model.ts";
import type { AnyPort, Port, PortArgs, PortError, PortValue } from "./port.ts";
import type { Decider, PlannedRule, RulesetOut, RunnableRuleset, RulesetPorts } from "./ruleset.ts";

export type InputFailure = {
  readonly step: "input";
  readonly error: { readonly issues: readonly StandardSchemaV1.Issue[] };
};
export type LoadFailure<L> = { readonly step: "load"; readonly error: "NOT_FOUND" | PortError<L> };

type AnyLoad = AnyPort;
export type Existing<L> = [L] extends [never] ? never : Exclude<PortValue<L>, null>;
type LoadId<M extends Model> = "id" extends keyof Value<M> ? Exclude<Value<M>["id"], undefined> : never;
type LoadIdMismatch<M extends Model, L> = [LoadId<M>] extends [never]
  ? { readonly "load には入力スキーマの id が要る": true }
  : [LoadId<M>] extends [PortArgs<L>[0]]
    ? unknown
    : { readonly "load が検証済みの id を受け取れない": LoadId<M> };

// 更新では既存の値に入力を重ねて next にするので、既存の値は入力の型にも代入できなければならない
type LoadMismatch<M extends Model, L> = [L] extends [never]
  ? unknown
  : [PortValue<L>] extends [(Value<M> & Persisted<M>) | null]
    ? LoadIdMismatch<M, L>
    : { readonly "load の返り値が入力と永続化の型に代入できない": PortValue<L> };

type SaveStart<M extends Model, L> = SaveState<Existing<L> | null, Value<M>>;
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
  readonly methods: BuildMethods;
};

// load の型を値・引数・失敗に分けて受け取る。メソッドを作るときに、検証した id で load を呼べることと、
// 既存の値が入力と永続化の型に代入できることを、型引数の制約で表すため
export function modelRules<
  N extends string,
  In,
  P,
  LA = unknown,
  Out extends { readonly id?: LA | undefined } = { readonly id?: LA | undefined },
  LT extends (Out & P) | null = never,
  LE = never,
  L extends Port<string, [LA], LT, LE> = never,
  Save extends RunnableRuleset<SaveState<NoInfer<LT & {}> | null, NoInfer<Out>>, unknown, unknown, string> | undefined =
    undefined,
  Del extends RunnableRuleset<DeleteState<NoInfer<LT & {}>>, unknown, unknown, string> | undefined = undefined,
>(
  m: Model<N, In, Out, P>,
  def: {
    readonly load?: L & Port<string, [LA], LT, LE> & LoadMismatch<Model<N, In, Out, P>, L>;
    readonly save?: Save &
      PersistedGuard<Model<N, In, Out, P>, SaveEnd<Model<N, In, Out, P>, NoInfer<L>, NoInfer<Save>>>;
    readonly delete?: Del & ([L] extends [never] ? { readonly "delete には load が要る": true } : unknown);
  },
): ModelRules<Model<N, In, Out, P>, NoInfer<L>, NoInfer<Save>, NoInfer<Del>> {
  const set: ModelRules<Model<N, In, Out, P>, L, Save, Del> = {
    kind: "modelRules",
    name: m.name,
    model: m,
    load: def.load,
    save: def.save,
    delete: def.delete,
    methods: modelMethods({ schema: m.schema.input, load: def.load, save: def.save, delete: def.delete }),
  };
  return Object.freeze(set);
}

export type ActionRules<A extends Action = Action, Rs extends AnyDecider = AnyDecider> = {
  readonly kind: "actionRules";
  readonly name: A["name"];
  readonly action: A;
  readonly rules: Rs;
  readonly methods: BuildMethods;
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
): ActionRules<Action<N, In, Out>, Decider<DecideState<Out>, Decided<DecideState<Out> & D, T>, E, PN>> {
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
    methods: actionMethods(a.input, decided),
  });
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
