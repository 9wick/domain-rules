import * as Result from "../shared/result.ts";
import { getOrEmpty, type OmittableIfEmpty } from "as-free";
import type { DeleteState, Model, Persisted, SaveState } from "../definition/model.ts";
import type { Args, BindCtx } from "../method/context.ts";
import {
  createMethod,
  deleteMethod,
  updateMethod,
  upsertMethod,
  type CreateMethod,
  type DeleteRun,
  type LoadFailureOf,
  type LoadInput,
  type LoadRun,
  type SaveRun,
} from "../method/model-methods.ts";
import { resolvePorts, unwrapPorts, type PortFns, type Requires, type StrictRecord } from "../pipeline/requires.ts";
import type { Checked, CheckTools, FailureOf, SuccessOf } from "../pipeline/rule.ts";
import type { PlannedRule, RulesetError, RulesetOut, RunnableRuleset, RulesetPorts } from "../pipeline/ruleset.ts";
import { safeTryWith } from "../pipeline/safe-try.ts";
import type { AnyPort, NoPorts, PortNames } from "../port/port.ts";
import type { Invocation } from "../port/invocation.ts";

type ActorOf<S> = S extends { readonly actor: infer A } ? A : never;

export type LoadFailure<E> = LoadFailureOf<E>;

// 取得ステップの定義。fetch は rule の check と同じく、requires に書いた port だけを受け取る
type LoadDef<Out extends { readonly id?: unknown }, Act, Q extends Requires, R, Pre, LE> = {
  readonly requires?: Q & StrictRecord<Q>;
  readonly fetch: (
    args: Args<LoadInput<Out>, Act>,
    ports: PortFns<Q>,
    tools: CheckTools<Q>,
  ) => R & NoInfer<Checked<Pre, LE>>;
} & OmittableIfEmpty<"requires", Q & StrictRecord<Q>>;

const loadRun = <Out extends { readonly id?: unknown }, Act, Q extends Requires, R, Pre, LE>(
  def: LoadDef<Out, Act, Q, R, Pre, LE>,
  requires: Q,
): LoadRun<Out, Act, Pre, LE> => {
  const fetch: (args: Args<LoadInput<Out>, Act>, ports: PortFns<Q>, tools: CheckTools<Q>) => Checked<Pre, LE> =
    def.fetch;
  return {
    run: async (args, invocation: Invocation): Promise<Result.Result<Pre, LE>> =>
      fetch(args, resolvePorts(requires, invocation), { safeTry: safeTryWith(unwrapPorts(requires, invocation)) }),
  };
};

// 保存の線路の最後の状態は、next が永続化の型になっていなければならない
type PersistedGuard<M extends Model, End> = [End] extends [never]
  ? unknown
  : [End] extends [{ readonly next: Persisted<M> }]
    ? unknown
    : { readonly "最後の next が永続化の型にならない": End extends { readonly next: infer X } ? X : never };

// update は重ねた next をもう一度 schema に通すので、schema はモデルの値もそのまま受け付けなければならない
type ReparseGuard<In, Out> = [Out] extends [In]
  ? unknown
  : { readonly "update で next を schema に通すため、schema.input はモデルの値も受け付けなければならない": Out };

declare const setPorts: unique symbol;

// model の rule の組が使う port の名前
export type ModelRulesPorts<S> = S extends { readonly [setPorts]: infer PN } ? PN : never;

type Methods<Ms> = (ctx: BindCtx) => Ms;
export type PlannedLoad = { readonly ports: readonly string[] };
export type Plans = {
  readonly load?: PlannedLoad;
  readonly save?: readonly PlannedRule[];
  readonly delete?: readonly PlannedRule[];
};

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

  // 取得ステップは rule の check と同じく、requires の port を受け取り Result を返す。
  // 成功の値は既存の値として線路に載るので、入力と永続化の型に代入できることを fetch の返り値の制約で表す。
  // 引数の型に条件型を重ねると fetch の返り値から型を推論できなくなるので、制約は型引数に置く
  load<
    O extends { readonly id?: unknown },
    R extends Checked<O & P, unknown>,
    Q extends Requires = NoPorts,
    // R の制約で確かめた代入を、成功の値の型そのままで Pre の制約として残す
    Pre extends O & P = SuccessOf<R> extends O & P ? SuccessOf<R> : never,
    LE = FailureOf<R>,
  >(
    this: ModelRulesStart<N, In, O, P, Act>,
    def: LoadDef<O, Act, Q, R, Pre, LE>,
  ): ModelRulesLoaded<N, In, O, P, Act, Pre, LE, PortNames<Q>, {}> {
    const requires: Q = getOrEmpty<"requires", Q & StrictRecord<Q>>(def, "requires");
    const ports: readonly AnyPort[] = Object.values(requires);
    return new ModelRulesLoaded<N, In, O, P, Act, Pre, LE, PortNames<Q>, {}>(
      this.model,
      loadRun<O, Act, Q, R, Pre, LE>(def, requires),
      { load: { ports: ports.map((p) => p.name) } },
      ports,
      this.resolveIn,
    );
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
  Out extends { readonly id?: unknown },
  P,
  Act,
  Pre extends Out,
  LE,
  PN extends string,
  Ms,
> implements ModelRules<N, Ms, PN> {
  declare readonly [setPorts]: PN;
  readonly kind = "modelRules";
  readonly name: N;
  readonly model: Model<N, In, Out, P, Act>;
  readonly load: LoadRun<Out, Act, Pre, LE>;
  readonly plans: Plans;
  readonly ports: readonly AnyPort[];
  readonly resolveIn: Methods<Ms>;

  constructor(
    model: Model<N, In, Out, P, Act>,
    load: LoadRun<Out, Act, Pre, LE>,
    plans: Plans,
    ports: readonly AnyPort[],
    resolveIn: Methods<Ms>,
  ) {
    this.name = model.name;
    this.model = model;
    this.load = load;
    this.plans = plans;
    this.ports = ports;
    this.resolveIn = resolveIn;
    Object.freeze(this);
  }

  save<
    Save extends RunnableRuleset<SaveState<NoInfer<Pre> | null, NoInfer<Out>, NoInfer<Act>>, unknown, unknown, string>,
    SA = ActorOf<SaveState<Pre | null, Out, Act> & RulesetOut<Save>>,
    SE = RulesetError<Save>,
  >(
    this: ModelRulesLoaded<N, In, Out, P, Act, Pre, LE, PN, Ms & { readonly create?: never }>,
    rules: Save &
      PersistedGuard<Model<N, In, Out, P, Act>, SaveState<Pre | null, Out, Act> & RulesetOut<NoInfer<Save>>> &
      ReparseGuard<In, Out> &
      SaveRun<NoInfer<Pre>, NoInfer<Out>, NoInfer<P>, NoInfer<Act>, NoInfer<SA>, NoInfer<SE>>,
  ) {
    const { model, load, resolveIn } = this;
    const create = createMethod<N, In, Out, P, Act, SA, SE>(model, rules);
    const update = updateMethod<N, In, Out, P, Act, Pre, LE, SA, SE>(model, load, rules);
    const upsert = upsertMethod<N, In, Out, P, Act, Pre, LE, SA, SE>(model, load, rules);
    return new ModelRulesLoaded<N, In, Out, P, Act, Pre, LE, PN | RulesetPorts<Save>, ReturnType<typeof methods>>(
      model,
      load,
      { ...this.plans, save: rules.plan },
      [...this.ports, ...rules.ports],
      methods,
    );
    function methods(ctx: BindCtx) {
      return Object.freeze({ ...resolveIn(ctx), create: create(ctx), update: update(ctx), upsert: upsert(ctx) });
    }
  }

  delete<
    Del extends RunnableRuleset<DeleteState<NoInfer<Pre>, NoInfer<Act>>, unknown, unknown, string>,
    DA = ActorOf<DeleteState<Pre, Act> & RulesetOut<Del>>,
    DE = RulesetError<Del>,
  >(
    this: ModelRulesLoaded<N, In, Out, P, Act, Pre, LE, PN, Ms & { readonly delete?: never }>,
    rules: Del & DeleteRun<NoInfer<Pre>, NoInfer<Act>, NoInfer<DA>, NoInfer<DE>>,
  ) {
    const { model, load, resolveIn } = this;
    const remove = deleteMethod<N, In, Out, P, Act, Pre, LE, DA, DE>(model, load, rules);
    return new ModelRulesLoaded<N, In, Out, P, Act, Pre, LE, PN | RulesetPorts<Del>, ReturnType<typeof methods>>(
      model,
      load,
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
