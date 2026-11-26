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
export type SaveRun<Pre, Next, P, Act, A, E> = {
  readonly run: (
    s: SaveState<Pre | null, Next, Act>,
    invocation: Invocation,
  ) => Promise<Result.Result<{ readonly next: P; readonly actor: A }, E>>;
};
export type DeleteRun<Pre, Key, Act, A, E> = {
  readonly run: (
    s: DeleteState<Pre, Key, Act>,
    invocation: Invocation,
  ) => Promise<Result.Result<{ readonly actor: A }, E>>;
};

type IdOf<KI> = NonNullable<Partial<KI>["id" & keyof Partial<KI>]>;
// update と delete は既存の値を id で指すので、key の id だけは必須にする
type WithId<KI> = Omit<KI, "id"> & { readonly id: IdOf<KI> };
// create は id を受け取らず、key と value の全体を受け取る
type CreateInput<KI, VI> = Omit<KI, "id"> & VI;
// update は key で既存の値を指し、value は変える項目だけを受け取る
type UpdateInput<KI, VI> = WithId<KI> & Partial<VI>;

export type CreateMethod<N extends string, KI, KO, VI, VO, P, Act, A, E> = (
  args: Args<CreateInput<KI, VI>, Act>,
) => Result.ResultAsync<Persistable<Model<N, KI, KO, VI, VO, P, Act>, "create", P, A>, InputFailure | E>;
export type UpdateMethod<N extends string, KI, KO, VI, VO, P, Act, Pre, A, E, LE> = (
  args: Args<UpdateInput<KI, VI>, Act>,
) => Result.ResultAsync<
  Persistable<Model<N, KI, KO, VI, VO, P, Act>, "update", Pre, A>,
  InputFailure | LoadFailureOf<LE> | E
>;
export type UpsertMethod<N extends string, KI, KO, VI, VO, P, Act, Pre, A, E, LE> = (
  args: Args<CreateInput<KI, VI> | UpdateInput<KI, VI>, Act>,
) => Result.ResultAsync<
  Persistable<Model<N, KI, KO, VI, VO, P, Act>, "create" | "update", Pre, A>,
  InputFailure | LoadFailureOf<LE> | E
>;
export type DeleteMethod<N extends string, KI, KO, VI, VO, P, Act, Pre, A, E, LE> = (
  args: Args<WithId<KI>, Act>,
) => Result.ResultAsync<Deletable<Model<N, KI, KO, VI, VO, P, Act>, Pre, A>, InputFailure | LoadFailureOf<LE> | E>;

type AnyModel<KO, VO> = Model<string, unknown, KO, unknown, VO>;

// 線路の input は呼び出し側が指定した項目だけを持つ。値は next から取り、key と差分を重ねた型を next の型のまま保つ
const pickFrom = <T extends object>(value: T, keys: readonly string[]): Partial<T> => {
  const out: Partial<T> = {};
  for (const k in value) if (keys.includes(k)) out[k] = value[k];
  return out;
};

const saveWith = async <Pre, Next, P, Act, A, E>(
  rules: SaveRun<Pre, Next, P, Act, A, E>,
  inv: Invocation,
  pre: Pre | null,
  next: Next,
  input: Partial<Next>,
  actor: Act,
) => {
  const r = await rules.run({ pre, next, input: Object.freeze({ ...input }), actor, now: inv.now }, inv);
  if (r.type === "Failure") return r;
  return Result.succeed({ next: Object.freeze(r.value.next), actor: r.value.actor });
};

// 検証の問題は key と value の分をまとめて1つの input の失敗にする
const failedIssues = (
  ...rs: readonly (StandardSchemaV1.Issue[] | Result.Result<unknown, StandardSchemaV1.Issue[]>)[]
): StandardSchemaV1.Issue[] => rs.flatMap((r) => (Array.isArray(r) ? r : r.type === "Failure" ? r.error : []));

const isEntry = (model: AnyModel<unknown, unknown>, key: string) =>
  Object.hasOwn(model.entries.key, key) || Object.hasOwn(model.entries.value, key);

const createIn = async <N extends string, KI, KO, VI, VO, P, Act, A, E>(
  ctx: BindCtx,
  model: Model<N, KI, KO, VI, VO, P, Act>,
  rules: SaveRun<never, ValueOf<KO, VO>, P, Act, A, E>,
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
  return Result.succeed(
    seal<"persistable", N, "create", { readonly pre: null; readonly next: Readonly<P>; readonly actor: A }>({
      pre: null,
      ...r.value,
    }),
  );
};

// 取得の前に key を検証し、不正な key では DB を引かない
const loadByKey = async <KO extends { readonly id?: unknown }, Act, Pre, LE>(
  ctx: BindCtx,
  key: Result.Result<KO, StandardSchemaV1.Issue[]>,
  load: LoadRun<KO, Act, Pre, LE>,
  issues: readonly StandardSchemaV1.Issue[],
  actor: Act,
) => {
  if (key.type === "Failure" || issues.length > 0) return Result.fail(inputFailure(failedIssues([...issues], key)));
  const { id } = key.value;
  if (id === undefined || id === null) return Result.fail(inputFailure([{ message: "id は必須です", path: ["id"] }]));
  const inv = ctx.invocation();
  const pre = await load.run({ input: { ...key.value, id }, actor }, inv);
  if (pre.type === "Failure") return Result.fail<LoadFailureOf<LE>>({ step: "load", error: pre.error });
  return Result.succeed({ inv, pre: pre.value, key: key.value });
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
>(
  ctx: BindCtx,
  model: Model<N, KI, KO, VI, VO, P, Act>,
  load: LoadRun<KO, Act, Pre, LE>,
  rules: SaveRun<Pre, ValueOf<KO, VO>, P, Act, A, E>,
  input: State,
  actor: Act,
) => {
  const { key, value } = model.schema;
  const unknown = unknownKeys(input, (k) => isEntry(model, k));
  const patch = await validatePartial(model.entries.value, pickEntries(model.entries.value, input));
  const existing = await loadByKey(
    ctx,
    await validateWhole(key, pickEntries(model.entries.key, input)),
    load,
    failedIssues(unknown, patch),
    actor,
  );
  if (existing.type === "Failure") return existing;
  if (patch.type === "Failure") return Result.fail(inputFailure(patch.error));
  const { inv, pre } = existing.value;
  const base: ValueOf<KO, VO> = pre;
  const next: ValueOf<KO, VO> = { ...base, ...patch.value };
  const whole = await checkWhole(value, pickEntries(model.entries.value, next));
  if (whole.type === "Failure") return whole;
  const given = pickFrom(next, [...Object.keys(existing.value.key), ...Object.keys(patch.value)]);
  const r = await saveWith(rules, inv, pre, next, given, actor);
  if (r.type === "Failure") return r;
  return Result.succeed(
    seal<"persistable", N, "update", { readonly pre: Readonly<Pre>; readonly next: Readonly<P>; readonly actor: A }>({
      pre: Object.freeze({ ...pre }),
      ...r.value,
    }),
  );
};

export const createMethod =
  <N extends string, KI, KO, VI, VO, P, Act, A, E>(
    model: Model<N, KI, KO, VI, VO, P, Act>,
    rules: SaveRun<never, ValueOf<KO, VO>, P, Act, A, E>,
  ): ((ctx: BindCtx) => CreateMethod<N, KI, KO, VI, VO, P, Act, A, E>) =>
  (ctx) =>
  ({ input, actor }) =>
    createIn(ctx, model, rules, input, actor);

export const updateMethod =
  <N extends string, KI, KO extends { readonly id?: unknown }, VI, VO, P, Act, Pre extends ValueOf<KO, VO>, LE, A, E>(
    model: Model<N, KI, KO, VI, VO, P, Act>,
    load: LoadRun<KO, Act, Pre, LE>,
    rules: SaveRun<Pre, ValueOf<KO, VO>, P, Act, A, E>,
  ): ((ctx: BindCtx) => UpdateMethod<N, KI, KO, VI, VO, P, Act, Pre, A, E, LE>) =>
  (ctx) =>
  ({ input, actor }) =>
    updateIn(ctx, model, load, rules, input, actor);

// input に id がなければ新規作成、あれば更新する
export const upsertMethod =
  <N extends string, KI, KO extends { readonly id?: unknown }, VI, VO, P, Act, Pre extends ValueOf<KO, VO>, LE, A, E>(
    model: Model<N, KI, KO, VI, VO, P, Act>,
    load: LoadRun<KO, Act, Pre, LE>,
    rules: SaveRun<Pre, ValueOf<KO, VO>, P, Act, A, E>,
  ): ((ctx: BindCtx) => UpsertMethod<N, KI, KO, VI, VO, P, Act, Pre, A, E, LE>) =>
  (ctx) =>
  ({ input, actor }) => {
    const fields: State = input;
    return fields["id"] === undefined
      ? createIn(ctx, model, rules, fields, actor)
      : updateIn(ctx, model, load, rules, fields, actor);
  };

export const deleteMethod =
  <N extends string, KI, KO extends { readonly id?: unknown }, VI, VO, P, Act, Pre extends ValueOf<KO, VO>, LE, A, E>(
    model: Model<N, KI, KO, VI, VO, P, Act>,
    load: LoadRun<KO, Act, Pre, LE>,
    rules: DeleteRun<Pre, KO, Act, A, E>,
  ): ((ctx: BindCtx) => DeleteMethod<N, KI, KO, VI, VO, P, Act, Pre, A, E, LE>) =>
  (ctx) =>
  async ({ input, actor }) => {
    const { key } = model.schema;
    const fields: State = input;
    const unknown = unknownKeys(fields, (k) => Object.hasOwn(model.entries.key, k));
    const existing = await loadByKey(
      ctx,
      await validateWhole(key, pickEntries(model.entries.key, fields)),
      load,
      unknown,
      actor,
    );
    if (existing.type === "Failure") return existing;
    const { inv, pre } = existing.value;
    const r = await rules.run(
      { pre, next: null, input: Object.freeze({ ...existing.value.key }), actor, now: inv.now },
      inv,
    );
    if (r.type === "Failure") return r;
    return Result.succeed(
      seal<"deletable", N, "delete", { readonly pre: Readonly<Pre>; readonly actor: A }>({
        pre: Object.freeze({ ...pre }),
        actor: r.value.actor,
      }),
    );
  };
