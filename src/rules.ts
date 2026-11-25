import { Result } from "@praha/byethrow";
import {
  actionMethods,
  createMethod,
  deleteMethod,
  updateMethod,
  upsertMethod,
  type BindCtx,
  type CreateMethod,
  type DecideMethod,
  type DeleteRun,
  type InputFailure,
  type LoadFailureOf,
  type SaveRun,
} from "./methods.ts";
import type { Action, Actor, DecideState, DeleteState, Model, Persisted, SaveState, Value } from "./model.ts";
import type { AnyPort, Port, PortArgs, PortError, PortValue } from "./port.ts";
import type { Decider, PlannedRule, RulesetError, RulesetOut, RunnableRuleset, RulesetPorts } from "./ruleset.ts";

type ActorOf<S> = S extends { readonly actor: infer A } ? A : never;

export type { InputFailure };
export type LoadFailure<L> = LoadFailureOf<PortError<L>>;

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

declare const setPorts: unique symbol;

type Methods<Ms> = (ctx: BindCtx) => Ms;
type Plans = { readonly save?: readonly PlannedRule[]; readonly delete?: readonly PlannedRule[] };

// bind に渡せる model の rule の組。メソッドの型 Ms は、load・save・delete を書くたびに、書いたものから決まる
export type ModelRules<N extends string = string, Ms = unknown, PN extends string = string> = {
  readonly [setPorts]: PN;
  readonly kind: "modelRules";
  readonly name: N;
  readonly plans: Plans;
  readonly ports: readonly AnyPort[];
  readonly resolveIn: Methods<Ms>;
};

type CreateStart<Out> = SaveState<null, Out>;

// これ以上メソッドを足せない rule の組
class ModelRulesDone<N extends string, Ms, PN extends string> implements ModelRules<N, Ms, PN> {
  declare readonly [setPorts]: PN;
  readonly kind = "modelRules";
  readonly name: N;
  readonly plans: Plans;
  readonly ports: readonly AnyPort[];
  readonly resolveIn: Methods<Ms>;

  constructor(name: N, plans: Plans, ports: readonly AnyPort[], resolveIn: Methods<Ms>) {
    this.name = name;
    this.plans = plans;
    this.ports = ports;
    this.resolveIn = resolveIn;
    Object.freeze(this);
  }
}

// load を書く前の rule の組。load を書かずに save を書くと、create だけを持つ
export class ModelRulesStart<N extends string, In, Out, P> implements ModelRules<N, {}, never> {
  declare readonly [setPorts]: never;
  readonly kind = "modelRules";
  readonly name: N;
  readonly model: Model<N, In, Out, P>;
  readonly plans: Plans = {};
  readonly ports: readonly AnyPort[] = [];
  readonly resolveIn: Methods<{}> = () => Object.freeze({});

  constructor(model: Model<N, In, Out, P>) {
    this.name = model.name;
    this.model = model;
    Object.freeze(this);
  }

  // load の型を値・引数・失敗に分けて受け取る。メソッドを作るときに、検証した id で load を呼べることと、
  // 既存の値が入力と永続化の型に代入できることを、型引数の制約で表すため
  load<
    LA,
    LT extends (O & P) | null,
    LE,
    L extends Port<string, [LA], LT, LE>,
    O extends { readonly id?: LA | undefined },
  >(
    this: ModelRulesStart<N, In, O, P>,
    port: L & Port<string, [LA], LT, LE> & LoadMismatch<Model<N, In, O, P>, L>,
  ): ModelRulesLoaded<N, In, O, P, LA, LT, LE, L["name"], {}> {
    return new ModelRulesLoaded(this.model, port, {}, [port], this.resolveIn);
  }

  // create は load を通らないので、線路は pre が null の状態から始まる
  save<
    Save extends RunnableRuleset<CreateStart<NoInfer<Out>>, unknown, unknown, string>,
    SA = ActorOf<CreateStart<Out> & RulesetOut<Save>>,
    SE = RulesetError<Save>,
  >(
    rules: Save &
      PersistedGuard<Model<N, In, Out, P>, CreateStart<Out> & RulesetOut<NoInfer<Save>>> &
      SaveRun<never, NoInfer<Out>, NoInfer<P>, NoInfer<SA>, NoInfer<SE>>,
  ): ModelRulesDone<N, { readonly create: CreateMethod<N, In, Out, P, SA, SE> }, RulesetPorts<Save>> {
    const create = createMethod<N, In, Out, P, SA, SE>(this.model, rules);
    return new ModelRulesDone(this.name, { save: rules.plan }, rules.ports, (ctx: BindCtx) =>
      Object.freeze({ create: create(ctx) }),
    );
  }
}

// load を書いたあとの rule の組。save と delete を、それぞれ1回まで書ける
export class ModelRulesLoaded<
  N extends string,
  In,
  Out extends { readonly id?: LA | undefined },
  P,
  LA,
  LT extends Out | null,
  LE,
  PN extends string,
  Ms,
> implements ModelRules<N, Ms, PN> {
  declare readonly [setPorts]: PN;
  readonly kind = "modelRules";
  readonly name: N;
  readonly model: Model<N, In, Out, P>;
  readonly port: Port<string, [LA], LT, LE>;
  readonly plans: Plans;
  readonly ports: readonly AnyPort[];
  readonly resolveIn: Methods<Ms>;

  constructor(
    model: Model<N, In, Out, P>,
    port: Port<string, [LA], LT, LE>,
    plans: Plans,
    ports: readonly AnyPort[],
    resolveIn: Methods<Ms>,
  ) {
    this.name = model.name;
    this.model = model;
    this.port = port;
    this.plans = plans;
    this.ports = ports;
    this.resolveIn = resolveIn;
    Object.freeze(this);
  }

  save<
    Save extends RunnableRuleset<SaveState<NoInfer<LT & {}> | null, NoInfer<Out>>, unknown, unknown, string>,
    SA = ActorOf<SaveState<(LT & {}) | null, Out> & RulesetOut<Save>>,
    SE = RulesetError<Save>,
  >(
    this: ModelRulesLoaded<N, In, Out, P, LA, LT, LE, PN, Ms & { readonly create?: never }>,
    rules: Save &
      PersistedGuard<Model<N, In, Out, P>, SaveState<(LT & {}) | null, Out> & RulesetOut<NoInfer<Save>>> &
      SaveRun<NoInfer<LT & {}>, NoInfer<Out>, NoInfer<P>, NoInfer<SA>, NoInfer<SE>>,
  ) {
    const { model, port, resolveIn } = this;
    const create = createMethod<N, In, Out, P, SA, SE>(model, rules);
    const update = updateMethod<N, In, Out, P, LA, LT, LE, SA, SE>(model, port, rules);
    const upsert = upsertMethod<N, In, Out, P, LA, LT, LE, SA, SE>(model, port, rules);
    return new ModelRulesLoaded<N, In, Out, P, LA, LT, LE, PN | RulesetPorts<Save>, ReturnType<typeof methods>>(
      model,
      port,
      { ...this.plans, save: rules.plan },
      [...this.ports, ...rules.ports],
      methods,
    );
    function methods(ctx: BindCtx) {
      return Object.freeze({ ...resolveIn(ctx), create: create(ctx), update: update(ctx), upsert: upsert(ctx) });
    }
  }

  delete<
    Del extends RunnableRuleset<DeleteState<NoInfer<LT & {}>>, unknown, unknown, string>,
    DA = ActorOf<DeleteState<LT & {}> & RulesetOut<Del>>,
    DE = RulesetError<Del>,
  >(
    this: ModelRulesLoaded<N, In, Out, P, LA, LT, LE, PN, Ms & { readonly delete?: never }>,
    rules: Del & DeleteRun<NoInfer<LT & {}>, NoInfer<DA>, NoInfer<DE>>,
  ) {
    const { model, port, resolveIn } = this;
    const remove = deleteMethod<N, In, Out, P, LA, LT, LE, DA, DE>(model, port, rules);
    return new ModelRulesLoaded<N, In, Out, P, LA, LT, LE, PN | RulesetPorts<Del>, ReturnType<typeof methods>>(
      model,
      port,
      { ...this.plans, delete: rules.plan },
      [...this.ports, ...rules.ports],
      methods,
    );
    function methods(ctx: BindCtx) {
      return Object.freeze({ ...resolveIn(ctx), delete: remove(ctx) });
    }
  }
}

export const modelRules = <N extends string, In, Out, P>(m: Model<N, In, Out, P>): ModelRulesStart<N, In, Out, P> =>
  new ModelRulesStart(m);

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

export type RuleSet = ModelRules | ActionRules;

export type RuleSetPorts<S> = S extends { readonly kind: "modelRules"; readonly [setPorts]: infer PN }
  ? PN
  : S extends { readonly kind: "actionRules"; readonly rules: infer Rs }
    ? RulesetPorts<Rs>
    : never;

export function plan(set: ModelRules): Plans;
export function plan(set: ActionRules): { readonly rules: readonly PlannedRule[] };
export function plan(set: RuleSet) {
  return set.kind === "actionRules" ? { rules: set.rules.plan } : set.plans;
}

export type { Actor };
