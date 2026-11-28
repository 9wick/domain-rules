import * as Result from "../shared/result.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DeleteState, Model, SaveState, ValueOf } from "../definition/model.ts";
import type { Invocation } from "../port/invocation.ts";
import type { Args, BindCtx } from "./context.ts";
import { seal, type Deletable, type Persistable } from "./seal.ts";
import {
  checkWhole,
  inputFailure,
  pickEntries,
  unknownKeys,
  validatePartial,
  validateWhole,
  type InputFailure,
  type State,
} from "./validate.ts";

export type LoadFailureOf<LE> = { readonly step: "load"; readonly error: LE };

// 取得ステップに渡す入力。key の schema で検証した key に、識別子の id が必ず入る
export type LoadInput<KO extends { readonly id?: unknown }> = Readonly<KO> & {
  readonly id: NonNullable<KO["id"]>;
};

// 既存の値を取る取得ステップ。見つからないときにどう失敗するかは、取得ステップを書く利用者が決める
export type LoadRun<KO extends { readonly id?: unknown }, Act, Pre, LE> = {
  readonly run: (args: Args<LoadInput<KO>, Act>, invocation: Invocation) => Promise<Result.Result<Pre, LE>>;
};

// 線路を走らせるのに要る部分。保存の線路は、最後の next が永続化の型になっていることを返り値の型で約束する
export type SaveRun<Pre, Next, P, Act, A, E, Ev> = {
  readonly run: (
    s: SaveState<Pre | null, Next, Act>,
    invocation: Invocation,
  ) => Promise<
    Result.Result<{ readonly state: { readonly next: P; readonly actor: A }; readonly events: readonly Ev[] }, E>
  >;
};
export type DeleteRun<Pre, Key, Act, A, E, Ev> = {
  readonly run: (
    s: DeleteState<Pre, Key, Act>,
    invocation: Invocation,
  ) => Promise<Result.Result<{ readonly state: { readonly actor: A }; readonly events: readonly Ev[] }, E>>;
};

// メソッドの成功の値。封をした値と、封をしないイベントを並べる。イベントは配送する側が open せずに読む
export type Saved<S, Ev> = { readonly persistable: S; readonly events: readonly Ev[] };
export type Removed<S, Ev> = { readonly deletable: S; readonly events: readonly Ev[] };

type IdOf<KI> = NonNullable<Partial<KI>["id" & keyof Partial<KI>]>;
// update と delete は既存の値を id で指すので、key の id だけは必須にする
type WithId<KI> = Omit<KI, "id"> & { readonly id: IdOf<KI> };
// create は id を受け取らず、key と value の全体を受け取る
type CreateInput<KI, VI> = Omit<KI, "id"> & VI;
// update は key で既存の値を指し、value は変える項目だけを受け取る
type UpdateInput<KI, VI> = WithId<KI> & Partial<VI>;

export type CreateMethod<N extends string, KI, KO, VI, VO, P, Act, A, E, Ev> = (
  args: Args<CreateInput<KI, VI>, Act>,
) => Result.ResultAsync<Saved<Persistable<Model<N, KI, KO, VI, VO, P, Act>, "create", P, A>, Ev>, InputFailure | E>;
export type UpdateMethod<N extends string, KI, KO, VI, VO, P, Act, Pre, A, E, LE, Ev> = (
  args: Args<UpdateInput<KI, VI>, Act>,
) => Result.ResultAsync<
  Saved<Persistable<Model<N, KI, KO, VI, VO, P, Act>, "update", Pre, A>, Ev>,
  InputFailure | LoadFailureOf<LE> | E
>;
export type UpsertMethod<N extends string, KI, KO, VI, VO, P, Act, Pre, A, E, LE, Ev> = (
  args: Args<CreateInput<KI, VI> | UpdateInput<KI, VI>, Act>,
) => Result.ResultAsync<
  Saved<Persistable<Model<N, KI, KO, VI, VO, P, Act>, "create" | "update", Pre, A>, Ev>,
  InputFailure | LoadFailureOf<LE> | E
>;
export type DeleteMethod<N extends string, KI, KO, VI, VO, P, Act, Pre, A, E, LE, Ev> = (
  args: Args<WithId<KI>, Act>,
) => Result.ResultAsync<
  Removed<Deletable<Model<N, KI, KO, VI, VO, P, Act>, Pre, A>, Ev>,
  InputFailure | LoadFailureOf<LE> | E
>;

type AnyModel<KO, VO> = Model<string, unknown, KO, unknown, VO>;

// 線路の input は呼び出し側が指定した項目だけを持つ。値は next から取り、key と差分を重ねた型を next の型のまま保つ
const pickFrom = <T extends object>(value: T, keys: readonly string[]): Partial<T> => {
  const out: Partial<T> = {};
  for (const k in value) if (keys.includes(k)) out[k] = value[k];
  return out;
};

const saveWith = async <Pre, Next, P, Act, A, E, Ev>(
  rules: SaveRun<Pre, Next, P, Act, A, E, Ev>,
  inv: Invocation,
  pre: Pre | null,
  next: Next,
  input: Partial<Next>,
  actor: Act,
) => {
  const r = await rules.run({ pre, next, input: Object.freeze({ ...input }), actor, now: inv.now }, inv);
  if (r.type === "Failure") return r;
  const { state, events } = r.value;
  return Result.succeed({
    sealed: { next: Object.freeze(state.next), actor: state.actor },
    events: Object.freeze([...events]),
  });
};

// 検証の問題は key と value の分をまとめて1つの input の失敗にする
const failedIssues = (
  ...rs: readonly (StandardSchemaV1.Issue[] | Result.Result<unknown, StandardSchemaV1.Issue[]>)[]
): StandardSchemaV1.Issue[] => rs.flatMap((r) => (Array.isArray(r) ? r : r.type === "Failure" ? r.error : []));

const isEntry = (model: AnyModel<unknown, unknown>, key: string) =>
  Object.hasOwn(model.entries.key, key) || Object.hasOwn(model.entries.value, key);

const createIn = async <N extends string, KI, KO, VI, VO, P, Act, A, E, Ev>(
  ctx: BindCtx,
  model: Model<N, KI, KO, VI, VO, P, Act>,
  rules: SaveRun<never, ValueOf<KO, VO>, P, Act, A, E, Ev>,
  input: State,
  actor: Act,
) => {
  const { key, value } = model.schema;
  const unknown = unknownKeys(input, (k) => k !== "id" && isEntry(model, k));
  const k = await validateWhole(key, pickEntries(model.entries.key, input));
  const v = await validateWhole(value, pickEntries(model.entries.value, input));
  const issues = failedIssues(unknown, k, v);
  if (issues.length > 0 || k.type === "Failure" || v.type === "Failure") return Result.fail(inputFailure(issues));
  const next: ValueOf<KO, VO> = { ...k.value, ...v.value };
  const r = await saveWith(rules, ctx.invocation(), null, next, next, actor);
  if (r.type === "Failure") return r;
  return Result.succeed({
    persistable: seal<
      "persistable",
      N,
      "create",
      { readonly pre: null; readonly next: Readonly<P>; readonly actor: A }
    >({ pre: null, ...r.value.sealed }),
    events: r.value.events,
  });
};

// update と delete の入力を、取得の前に検証する。不正な入力では DB を引かない。
// key 以外の項目の検証結果 rest も受け取り、key の問題とまとめて1つの input の失敗にする
const parseKeyed = <KO extends { readonly id?: unknown }, Rest>(
  key: Result.Result<KO, StandardSchemaV1.Issue[]>,
  rest: Result.Result<Rest, StandardSchemaV1.Issue[]>,
  unknown: readonly StandardSchemaV1.Issue[],
): Result.Result<{ readonly key: LoadInput<KO>; readonly rest: Rest }, InputFailure> => {
  if (key.type === "Failure" || rest.type === "Failure" || unknown.length > 0) {
    return Result.fail(inputFailure(failedIssues([...unknown], rest, key)));
  }
  const { id } = key.value;
  if (id === undefined || id === null) return Result.fail(inputFailure([{ message: "id is required", path: ["id"] }]));
  return Result.succeed({ key: { ...key.value, id }, rest: rest.value });
};

const loadByKey = async <KO extends { readonly id?: unknown }, Act, Pre, LE>(
  ctx: BindCtx,
  load: LoadRun<KO, Act, Pre, LE>,
  key: LoadInput<KO>,
  actor: Act,
) => {
  const inv = ctx.invocation();
  const pre = await load.run({ input: key, actor }, inv);
  if (pre.type === "Failure") return Result.fail<LoadFailureOf<LE>>({ step: "load", error: pre.error });
  return Result.succeed({ inv, pre: pre.value });
};

// 更新では、既存の値に差分を重ねて next にし、create と同じく value の schema 全体で確かめる。
// key の項目は既存の値のまま残す。その key で取得したので、入力の key と同じ値になる
const updateIn = async <
  N extends string,
  KI,
  KO extends { readonly id?: unknown },
  VI,
  VO,
  P,
  Act,
  Pre extends ValueOf<KO, VO>,
  LE,
  A,
  E,
  Ev,
>(
  ctx: BindCtx,
  model: Model<N, KI, KO, VI, VO, P, Act>,
  load: LoadRun<KO, Act, Pre, LE>,
  rules: SaveRun<Pre, ValueOf<KO, VO>, P, Act, A, E, Ev>,
  input: State,
  actor: Act,
) => {
  const { key, value } = model.schema;
  const parsed = parseKeyed(
    await validateWhole(key, pickEntries(model.entries.key, input)),
    await validatePartial(model.entries.value, pickEntries(model.entries.value, input)),
    unknownKeys(input, (k) => isEntry(model, k)),
  );
  if (parsed.type === "Failure") return parsed;
  const { key: keyed, rest: patch } = parsed.value;
  const existing = await loadByKey(ctx, load, keyed, actor);
  if (existing.type === "Failure") return existing;
  const { inv, pre } = existing.value;
  const base: ValueOf<KO, VO> = pre;
  const next: ValueOf<KO, VO> = { ...base, ...patch };
  const whole = await checkWhole(value, pickEntries(model.entries.value, next));
  if (whole.type === "Failure") return whole;
  const given = pickFrom(next, [...Object.keys(keyed), ...Object.keys(patch)]);
  const r = await saveWith(rules, inv, pre, next, given, actor);
  if (r.type === "Failure") return r;
  return Result.succeed({
    persistable: seal<
      "persistable",
      N,
      "update",
      { readonly pre: Readonly<Pre>; readonly next: Readonly<P>; readonly actor: A }
    >({ pre: Object.freeze({ ...pre }), ...r.value.sealed }),
    events: r.value.events,
  });
};

export const createMethod =
  <N extends string, KI, KO, VI, VO, P, Act, A, E, Ev>(
    model: Model<N, KI, KO, VI, VO, P, Act>,
    rules: SaveRun<never, ValueOf<KO, VO>, P, Act, A, E, Ev>,
  ): ((ctx: BindCtx) => CreateMethod<N, KI, KO, VI, VO, P, Act, A, E, Ev>) =>
  (ctx) =>
  ({ input, actor }) =>
    createIn(ctx, model, rules, input, actor);

export const updateMethod =
  <
    N extends string,
    KI,
    KO extends { readonly id?: unknown },
    VI,
    VO,
    P,
    Act,
    Pre extends ValueOf<KO, VO>,
    LE,
    A,
    E,
    Ev,
  >(
    model: Model<N, KI, KO, VI, VO, P, Act>,
    load: LoadRun<KO, Act, Pre, LE>,
    rules: SaveRun<Pre, ValueOf<KO, VO>, P, Act, A, E, Ev>,
  ): ((ctx: BindCtx) => UpdateMethod<N, KI, KO, VI, VO, P, Act, Pre, A, E, LE, Ev>) =>
  (ctx) =>
  ({ input, actor }) =>
    updateIn(ctx, model, load, rules, input, actor);

// input に id がなければ新規作成、あれば更新する
export const upsertMethod =
  <
    N extends string,
    KI,
    KO extends { readonly id?: unknown },
    VI,
    VO,
    P,
    Act,
    Pre extends ValueOf<KO, VO>,
    LE,
    A,
    E,
    Ev,
  >(
    model: Model<N, KI, KO, VI, VO, P, Act>,
    load: LoadRun<KO, Act, Pre, LE>,
    rules: SaveRun<Pre, ValueOf<KO, VO>, P, Act, A, E, Ev>,
  ): ((ctx: BindCtx) => UpsertMethod<N, KI, KO, VI, VO, P, Act, Pre, A, E, LE, Ev>) =>
  (ctx) =>
  ({ input, actor }) => {
    const fields: State = input;
    return fields["id"] === undefined
      ? createIn(ctx, model, rules, fields, actor)
      : updateIn(ctx, model, load, rules, fields, actor);
  };

export const deleteMethod =
  <
    N extends string,
    KI,
    KO extends { readonly id?: unknown },
    VI,
    VO,
    P,
    Act,
    Pre extends ValueOf<KO, VO>,
    LE,
    A,
    E,
    Ev,
  >(
    model: Model<N, KI, KO, VI, VO, P, Act>,
    load: LoadRun<KO, Act, Pre, LE>,
    rules: DeleteRun<Pre, KO, Act, A, E, Ev>,
  ): ((ctx: BindCtx) => DeleteMethod<N, KI, KO, VI, VO, P, Act, Pre, A, E, LE, Ev>) =>
  (ctx) =>
  async ({ input, actor }) => {
    const { key } = model.schema;
    const fields: State = input;
    const parsed = parseKeyed(
      await validateWhole(key, pickEntries(model.entries.key, fields)),
      Result.succeed(undefined),
      unknownKeys(fields, (k) => Object.hasOwn(model.entries.key, k)),
    );
    if (parsed.type === "Failure") return parsed;
    const keyed = parsed.value.key;
    const existing = await loadByKey(ctx, load, keyed, actor);
    if (existing.type === "Failure") return existing;
    const { inv, pre } = existing.value;
    const r = await rules.run({ pre, next: null, input: Object.freeze({ ...keyed }), actor, now: inv.now }, inv);
    if (r.type === "Failure") return r;
    return Result.succeed({
      deletable: seal<"deletable", N, "delete", { readonly pre: Readonly<Pre>; readonly actor: A }>({
        pre: Object.freeze({ ...pre }),
        actor: r.value.state.actor,
      }),
      events: Object.freeze([...r.value.events]),
    });
  };
