import * as Result from "../shared/result.ts";
import { getOrEmpty, type OmittableIfEmpty } from "as-free";
import type { DeleteState, Model, Persisted, SaveState, ValueOf } from "../definition/model.ts";
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
import { withPorts, type CheckTools, type PortFns, type Requires, type StrictRecord } from "../pipeline/requires.ts";
import type { Checked, FailureOf, SuccessOf } from "../pipeline/rule.ts";
import type {
  PlannedRule,
  portNames,
  RulesetError,
  RulesetEvents,
  RulesetOut,
  RunnableRuleset,
  RulesetPorts,
} from "../pipeline/ruleset.ts";
import type { AnyPort, NoPorts, PortNames } from "../port/port.ts";
import type { Invocation } from "../port/invocation.ts";

type ActorOf<S> = S extends { readonly actor: infer A } ? A : never;

export type LoadFailure<E> = LoadFailureOf<E>;

// 取得ステップの定義。fetch は rule の check と同じく、requires に書いた port だけを受け取る
type LoadDef<KO extends { readonly id?: unknown }, Act, Q extends Requires, R, Pre, LE> = {
  readonly requires?: Q & StrictRecord<Q>;
  readonly fetch: (
    args: Args<LoadInput<KO>, Act>,
    ports: PortFns<Q>,
    tools: CheckTools<Q>,
  ) => R & NoInfer<Checked<Pre, LE>>;
} & OmittableIfEmpty<"requires", Q & StrictRecord<Q>>;

const loadRun = <KO extends { readonly id?: unknown }, Act, Q extends Requires, R, Pre, LE>(
  def: LoadDef<KO, Act, Q, R, Pre, LE>,
  requires: Q,
): LoadRun<KO, Act, Pre, LE> => {
  const fetch: (args: Args<LoadInput<KO>, Act>, ports: PortFns<Q>, tools: CheckTools<Q>) => Checked<Pre, LE> =
    def.fetch;
  const step = withPorts(requires, fetch);
  return { run: async (args, invocation: Invocation): Promise<Result.Result<Pre, LE>> => step(args, invocation) };
};

// 保存の線路の最後の状態は、next が永続化の型になっていなければならない
type PersistedGuard<M extends Model, End> = [End] extends [never]
  ? unknown
  : [End] extends [{ readonly next: Persisted<M> }]
    ? unknown
    : {
        readonly "the final next does not match the persisted type": End extends { readonly next: infer X } ? X : never;
      };

// update は重ねた値をもう一度 value の schema に通すので、schema は自分の出力もそのまま受け付けなければならない
type ReparseGuard<VI, VO> = [VO] extends [VI]
  ? unknown
  : { readonly "schema.value must accept its own output, because update re-parses the merged value": VO };

// update と delete は id で既存の値を指すので、load を書くには key の schema に id が要る
type KeyHasId<KO> = "id" extends keyof KO ? unknown : { readonly "the key schema must have id": never };

type Methods<Ms> = (ctx: BindCtx) => Ms;
export type PlannedLoad = { readonly ports: readonly string[] };
export type Plans = {
  readonly load?: PlannedLoad;
  readonly save?: readonly PlannedRule[];
  readonly delete?: readonly PlannedRule[];
};

// 書いた load・save・delete。plan と ports はこれだけから作り、別々に積み上げない
type Parts = {
  readonly load?: { readonly ports: readonly AnyPort[] };
  readonly save?: { readonly plan: readonly PlannedRule[]; readonly ports: readonly AnyPort[] };
  readonly delete?: { readonly plan: readonly PlannedRule[]; readonly ports: readonly AnyPort[] };
};

const planOf = ({ load, save, delete: del }: Parts): Plans => ({
  ...(load === undefined ? {} : { load: { ports: load.ports.map((p) => p.name) } }),
  ...(save === undefined ? {} : { save: save.plan }),
  ...(del === undefined ? {} : { delete: del.plan }),
});

const portsOf = ({ load, save, delete: del }: Parts): readonly AnyPort[] => [
  ...(load?.ports ?? []),
  ...(save?.ports ?? []),
  ...(del?.ports ?? []),
];

// bind に渡せる model の rule の組。メソッドの型 Ms は、load・save・delete を書くたびに、書いたものから決まる
export type ModelRules<N extends string = string, Ms = unknown, PN extends string = string> = {
  readonly [portNames]: PN;
  readonly kind: "modelRules";
  readonly name: N;
  readonly plan: Plans;
  readonly ports: readonly AnyPort[];
  readonly resolveIn: Methods<Ms>;
};

type CreateStart<Out, Act> = SaveState<null, Out, Act>;

// これ以上メソッドを足せない rule の組
class ModelRulesDone<N extends string, Ms, PN extends string> implements ModelRules<N, Ms, PN> {
  declare readonly [portNames]: PN;
  readonly kind = "modelRules";
  readonly name: N;
  readonly plan: Plans;
  readonly ports: readonly AnyPort[];
  readonly resolveIn: Methods<Ms>;

  constructor(name: N, parts: Parts, resolveIn: Methods<Ms>) {
    this.name = name;
    this.plan = planOf(parts);
    this.ports = portsOf(parts);
    this.resolveIn = resolveIn;
    Object.freeze(this);
  }
}

// load を書く前の rule の組。load を書かずに save を書くと、create だけを持つ
export class ModelRulesStart<N extends string, KI, KO, VI, VO, P, Act> implements ModelRules<N, {}, never> {
  declare readonly [portNames]: never;
  readonly kind = "modelRules";
  readonly name: N;
  readonly model: Model<N, KI, KO, VI, VO, P, Act>;
  readonly plan: Plans = {};
  readonly ports: readonly AnyPort[] = [];
  readonly resolveIn: Methods<{}> = () => Object.freeze({});

  constructor(model: Model<N, KI, KO, VI, VO, P, Act>) {
    this.name = model.name;
    this.model = model;
    Object.freeze(this);
  }

  // 取得ステップは rule の check と同じく、requires の port を受け取り Result を返す。
  // 成功の値は既存の値として線路に載るので、入力と永続化の型に代入できることを fetch の返り値の制約で表す。
  // 引数の型に条件型を重ねると fetch の返り値から型を推論できなくなるので、制約は型引数に置く
  load<
    O extends { readonly id?: unknown },
    R extends Checked<ValueOf<O, VO> & P, unknown>,
    Q extends Requires = NoPorts,
    // R の制約で確かめた代入を、成功の値の型そのままで Pre の制約として残す
    Pre extends ValueOf<O, VO> & P = SuccessOf<R> extends ValueOf<O, VO> & P ? SuccessOf<R> : never,
    LE = FailureOf<R>,
  >(
    this: ModelRulesStart<N, KI, O, VI, VO, P, Act>,
    def: LoadDef<O, Act, Q, R, Pre, LE> & KeyHasId<O>,
  ): ModelRulesLoaded<N, KI, O, VI, VO, P, Act, Pre, LE, PortNames<Q>, {}> {
    const requires: Q = getOrEmpty<"requires", Q & StrictRecord<Q>>(def, "requires");
    return new ModelRulesLoaded<N, KI, O, VI, VO, P, Act, Pre, LE, PortNames<Q>, {}>(
      this.model,
      loadRun<O, Act, Q, R, Pre, LE>(def, requires),
      { load: { ports: Object.values(requires) } },
      this.resolveIn,
    );
  }

  // create は load を通らないので、線路は pre が null の状態から始まる
  save<
    Save extends RunnableRuleset<
      CreateStart<NoInfer<ValueOf<KO, VO>>, NoInfer<Act>>,
      unknown,
      unknown,
      string,
      unknown
    >,
    SA = ActorOf<CreateStart<ValueOf<KO, VO>, Act> & RulesetOut<Save>>,
    SE = RulesetError<Save>,
    SV = RulesetEvents<Save>,
  >(
    rules: Save &
      PersistedGuard<Model<N, KI, KO, VI, VO, P, Act>, CreateStart<ValueOf<KO, VO>, Act> & RulesetOut<NoInfer<Save>>> &
      SaveRun<never, NoInfer<ValueOf<KO, VO>>, NoInfer<P>, NoInfer<Act>, NoInfer<SA>, NoInfer<SE>, NoInfer<SV>>,
  ): ModelRulesDone<N, { readonly create: CreateMethod<N, KI, KO, VI, VO, P, Act, SA, SE, SV> }, RulesetPorts<Save>> {
    const create = createMethod<N, KI, KO, VI, VO, P, Act, SA, SE, SV>(this.model, rules);
    return new ModelRulesDone(this.name, { save: rules }, (ctx: BindCtx) => Object.freeze({ create: create(ctx) }));
  }
}

// load を書いたあとの rule の組。save と delete を、それぞれ1回まで書ける
export class ModelRulesLoaded<
  N extends string,
  KI,
  KO extends { readonly id?: unknown },
  VI,
  VO,
  P,
  Act,
  Pre extends ValueOf<KO, VO>,
  LE,
  PN extends string,
  Ms,
> implements ModelRules<N, Ms, PN> {
  declare readonly [portNames]: PN;
  readonly kind = "modelRules";
  readonly name: N;
  readonly model: Model<N, KI, KO, VI, VO, P, Act>;
  readonly load: LoadRun<KO, Act, Pre, LE>;
  readonly plan: Plans;
  readonly ports: readonly AnyPort[];
  readonly resolveIn: Methods<Ms>;
  readonly #parts: Parts;

  constructor(
    model: Model<N, KI, KO, VI, VO, P, Act>,
    load: LoadRun<KO, Act, Pre, LE>,
    parts: Parts,
    resolveIn: Methods<Ms>,
  ) {
    this.name = model.name;
    this.model = model;
    this.load = load;
    this.#parts = parts;
    this.plan = planOf(parts);
    this.ports = portsOf(parts);
    this.resolveIn = resolveIn;
    Object.freeze(this);
  }

  save<
    Save extends RunnableRuleset<
      SaveState<NoInfer<Pre> | null, NoInfer<ValueOf<KO, VO>>, NoInfer<Act>>,
      unknown,
      unknown,
      string,
      unknown
    >,
    SA = ActorOf<SaveState<Pre | null, ValueOf<KO, VO>, Act> & RulesetOut<Save>>,
    SE = RulesetError<Save>,
    SV = RulesetEvents<Save>,
  >(
    this: ModelRulesLoaded<N, KI, KO, VI, VO, P, Act, Pre, LE, PN, Ms & { readonly create?: never }>,
    rules: Save &
      PersistedGuard<
        Model<N, KI, KO, VI, VO, P, Act>,
        SaveState<Pre | null, ValueOf<KO, VO>, Act> & RulesetOut<NoInfer<Save>>
      > &
      ReparseGuard<VI, VO> &
      SaveRun<NoInfer<Pre>, NoInfer<ValueOf<KO, VO>>, NoInfer<P>, NoInfer<Act>, NoInfer<SA>, NoInfer<SE>, NoInfer<SV>>,
  ) {
    const { model, load, resolveIn } = this;
    const create = createMethod<N, KI, KO, VI, VO, P, Act, SA, SE, SV>(model, rules);
    const update = updateMethod<N, KI, KO, VI, VO, P, Act, Pre, LE, SA, SE, SV>(model, load, rules);
    const upsert = upsertMethod<N, KI, KO, VI, VO, P, Act, Pre, LE, SA, SE, SV>(model, load, rules);
    return new ModelRulesLoaded<
      N,
      KI,
      KO,
      VI,
      VO,
      P,
      Act,
      Pre,
      LE,
      PN | RulesetPorts<Save>,
      ReturnType<typeof methods>
    >(model, load, { ...this.#parts, save: rules }, methods);
    function methods(ctx: BindCtx) {
      return Object.freeze({ ...resolveIn(ctx), create: create(ctx), update: update(ctx), upsert: upsert(ctx) });
    }
  }

  delete<
    Del extends RunnableRuleset<
      DeleteState<NoInfer<Pre>, NoInfer<KO>, NoInfer<Act>>,
      unknown,
      unknown,
      string,
      unknown
    >,
    DA = ActorOf<DeleteState<Pre, KO, Act> & RulesetOut<Del>>,
    DE = RulesetError<Del>,
    DV = RulesetEvents<Del>,
  >(
    this: ModelRulesLoaded<N, KI, KO, VI, VO, P, Act, Pre, LE, PN, Ms & { readonly delete?: never }>,
    rules: Del & DeleteRun<NoInfer<Pre>, NoInfer<KO>, NoInfer<Act>, NoInfer<DA>, NoInfer<DE>, NoInfer<DV>>,
  ) {
    const { model, load, resolveIn } = this;
    const remove = deleteMethod<N, KI, KO, VI, VO, P, Act, Pre, LE, DA, DE, DV>(model, load, rules);
    return new ModelRulesLoaded<N, KI, KO, VI, VO, P, Act, Pre, LE, PN | RulesetPorts<Del>, ReturnType<typeof methods>>(
      model,
      load,
      { ...this.#parts, delete: rules },
      methods,
    );
    function methods(ctx: BindCtx) {
      return Object.freeze({ ...resolveIn(ctx), delete: remove(ctx) });
    }
  }
}

export const modelRules = <N extends string, KI, KO, VI, VO, P, Act>(
  m: Model<N, KI, KO, VI, VO, P, Act>,
): ModelRulesStart<N, KI, KO, VI, VO, P, Act> => new ModelRulesStart(m);
