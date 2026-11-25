import type { DeleteState, Model, ModelActor, Persisted, SaveState, Value } from "../definition/model.ts";
import type { BindCtx } from "../method/context.ts";
import {
  createMethod,
  deleteMethod,
  updateMethod,
  upsertMethod,
  type CreateMethod,
  type DeleteRun,
  type LoadFailureOf,
  type SaveRun,
} from "../method/model-methods.ts";
import type { PlannedRule, RulesetError, RulesetOut, RunnableRuleset, RulesetPorts } from "../pipeline/ruleset.ts";
import type { AnyPort, Port, PortArgs, PortError, PortValue } from "../port/port.ts";

type ActorOf<S> = S extends { readonly actor: infer A } ? A : never;

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

type SaveStart<M extends Model, L> = SaveState<Existing<L> | null, Value<M>, ModelActor<M>>;
type DeleteStart<M extends Model, L> = DeleteState<Existing<L>, ModelActor<M>>;

// 線路は開始の状態に値を重ねていくので、最後の状態は開始の状態と線路が重ねた型の交差型になる
export type SaveEnd<M extends Model, L, Save> = SaveStart<M, L> & RulesetOut<Save>;
export type DeleteEnd<M extends Model, L, Del> = DeleteStart<M, L> & RulesetOut<Del>;

// 保存の線路の最後の状態は、next が永続化の型になっていなければならない
type PersistedGuard<M extends Model, End> = [End] extends [never]
  ? unknown
  : [End] extends [{ readonly next: Persisted<M> }]
    ? unknown
    : { readonly "最後の next が永続化の型にならない": End extends { readonly next: infer X } ? X : never };

export type AnyRunnable = RunnableRuleset<never, unknown, unknown, string>;

declare const setPorts: unique symbol;

// model の rule の組が使う port の名前
export type ModelRulesPorts<S> = S extends { readonly [setPorts]: infer PN } ? PN : never;

type Methods<Ms> = (ctx: BindCtx) => Ms;
export type Plans = { readonly save?: readonly PlannedRule[]; readonly delete?: readonly PlannedRule[] };

// bind に渡せる model の rule の組。メソッドの型 Ms は、load・save・delete を書くたびに、書いたものから決まる
export type ModelRules<N extends string = string, Ms = unknown, PN extends string = string> = {
  readonly [setPorts]: PN;
  readonly kind: "modelRules";
  readonly name: N;
  readonly plans: Plans;
  readonly ports: readonly AnyPort[];
  readonly resolveIn: Methods<Ms>;
};

type CreateStart<Out, Act> = SaveState<null, Out, Act>;

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
export class ModelRulesStart<N extends string, In, Out, P, Act> implements ModelRules<N, {}, never> {
  declare readonly [setPorts]: never;
  readonly kind = "modelRules";
  readonly name: N;
  readonly model: Model<N, In, Out, P, Act>;
  readonly plans: Plans = {};
  readonly ports: readonly AnyPort[] = [];
  readonly resolveIn: Methods<{}> = () => Object.freeze({});

  constructor(model: Model<N, In, Out, P, Act>) {
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
    this: ModelRulesStart<N, In, O, P, Act>,
    port: L & Port<string, [LA], LT, LE> & LoadMismatch<Model<N, In, O, P, Act>, L>,
  ): ModelRulesLoaded<N, In, O, P, Act, LA, LT, LE, L["name"], {}> {
    return new ModelRulesLoaded(this.model, port, {}, [port], this.resolveIn);
  }

  // create は load を通らないので、線路は pre が null の状態から始まる
  save<
    Save extends RunnableRuleset<CreateStart<NoInfer<Out>, NoInfer<Act>>, unknown, unknown, string>,
    SA = ActorOf<CreateStart<Out, Act> & RulesetOut<Save>>,
    SE = RulesetError<Save>,
  >(
    rules: Save &
      PersistedGuard<Model<N, In, Out, P, Act>, CreateStart<Out, Act> & RulesetOut<NoInfer<Save>>> &
      SaveRun<never, NoInfer<Out>, NoInfer<P>, NoInfer<Act>, NoInfer<SA>, NoInfer<SE>>,
  ): ModelRulesDone<N, { readonly create: CreateMethod<N, In, Out, P, Act, SA, SE> }, RulesetPorts<Save>> {
    const create = createMethod<N, In, Out, P, Act, SA, SE>(this.model, rules);
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
  Act,
  LA,
  LT extends Out | null,
  LE,
  PN extends string,
  Ms,
> implements ModelRules<N, Ms, PN> {
  declare readonly [setPorts]: PN;
  readonly kind = "modelRules";
  readonly name: N;
  readonly model: Model<N, In, Out, P, Act>;
  readonly port: Port<string, [LA], LT, LE>;
  readonly plans: Plans;
  readonly ports: readonly AnyPort[];
  readonly resolveIn: Methods<Ms>;

  constructor(
    model: Model<N, In, Out, P, Act>,
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
    Save extends RunnableRuleset<
      SaveState<NoInfer<LT & {}> | null, NoInfer<Out>, NoInfer<Act>>,
      unknown,
      unknown,
      string
    >,
    SA = ActorOf<SaveState<(LT & {}) | null, Out, Act> & RulesetOut<Save>>,
    SE = RulesetError<Save>,
  >(
    this: ModelRulesLoaded<N, In, Out, P, Act, LA, LT, LE, PN, Ms & { readonly create?: never }>,
    rules: Save &
      PersistedGuard<Model<N, In, Out, P, Act>, SaveState<(LT & {}) | null, Out, Act> & RulesetOut<NoInfer<Save>>> &
      SaveRun<NoInfer<LT & {}>, NoInfer<Out>, NoInfer<P>, NoInfer<Act>, NoInfer<SA>, NoInfer<SE>>,
  ) {
    const { model, port, resolveIn } = this;
    const create = createMethod<N, In, Out, P, Act, SA, SE>(model, rules);
    const update = updateMethod<N, In, Out, P, Act, LA, LT, LE, SA, SE>(model, port, rules);
    const upsert = upsertMethod<N, In, Out, P, Act, LA, LT, LE, SA, SE>(model, port, rules);
    return new ModelRulesLoaded<N, In, Out, P, Act, LA, LT, LE, PN | RulesetPorts<Save>, ReturnType<typeof methods>>(
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
    Del extends RunnableRuleset<DeleteState<NoInfer<LT & {}>, NoInfer<Act>>, unknown, unknown, string>,
    DA = ActorOf<DeleteState<LT & {}, Act> & RulesetOut<Del>>,
    DE = RulesetError<Del>,
  >(
    this: ModelRulesLoaded<N, In, Out, P, Act, LA, LT, LE, PN, Ms & { readonly delete?: never }>,
    rules: Del & DeleteRun<NoInfer<LT & {}>, NoInfer<Act>, NoInfer<DA>, NoInfer<DE>>,
  ) {
    const { model, port, resolveIn } = this;
    const remove = deleteMethod<N, In, Out, P, Act, LA, LT, LE, DA, DE>(model, port, rules);
    return new ModelRulesLoaded<N, In, Out, P, Act, LA, LT, LE, PN | RulesetPorts<Del>, ReturnType<typeof methods>>(
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

export const modelRules = <N extends string, In, Out, P, Act>(
  m: Model<N, In, Out, P, Act>,
): ModelRulesStart<N, In, Out, P, Act> => new ModelRulesStart(m);
