import * as Result from "../shared/result.ts";
import type { DeleteState, Model, SaveState } from "../definition/model.ts";
import type { Invocation } from "../port/invocation.ts";
import type { Args, BindCtx } from "./context.ts";
import { seal, type Deletable, type Persistable } from "./seal.ts";
import { inputFailure, validatePartial, validateWhole, type InputFailure, type State } from "./validate.ts";

export type LoadFailureOf<LE> = { readonly step: "load"; readonly error: LE };

// 取得ステップに渡す入力。検証した項目に、識別子の id が必ず入る
export type LoadInput<Out extends { readonly id?: unknown }> = Readonly<Partial<Out>> & {
  readonly id: NonNullable<Out["id"]>;
};

// 既存の値を取る取得ステップ。見つからないときにどう失敗するかは、取得ステップを書く利用者が決める
export type LoadRun<Out extends { readonly id?: unknown }, Act, Pre, LE> = {
  readonly run: (args: Args<LoadInput<Out>, Act>, invocation: Invocation) => Promise<Result.Result<Pre, LE>>;
};

// 線路を走らせるのに要る部分。保存の線路は、最後の next が永続化の型になっていることを返り値の型で約束する
export type SaveRun<Pre, Out, P, Act, A, E> = {
  readonly run: (
    s: SaveState<Pre | null, Out, Act>,
    invocation: Invocation,
  ) => Promise<Result.Result<{ readonly next: P; readonly actor: A }, E>>;
};
export type DeleteRun<Pre, Act, A, E> = {
  readonly run: (s: DeleteState<Pre, Act>, invocation: Invocation) => Promise<Result.Result<{ readonly actor: A }, E>>;
};

type IdOf<In> = NonNullable<Partial<In>["id" & keyof Partial<In>]>;

export type CreateMethod<N extends string, In, Out, P, Act, A, E> = (
  args: Args<Omit<Partial<In>, "id">, Act>,
) => Result.ResultAsync<Persistable<Model<N, In, Out, P, Act>, "create", P, A>, InputFailure | E>;
export type UpdateMethod<N extends string, In, Out, P, Act, Pre, A, E, LE> = (
  args: Args<Partial<In> & { readonly id: IdOf<In> }, Act>,
) => Result.ResultAsync<Persistable<Model<N, In, Out, P, Act>, "update", Pre, A>, InputFailure | LoadFailureOf<LE> | E>;
export type UpsertMethod<N extends string, In, Out, P, Act, Pre, A, E, LE> = (
  args: Args<Partial<In>, Act>,
) => Result.ResultAsync<
  Persistable<Model<N, In, Out, P, Act>, "create" | "update", Pre, A>,
  InputFailure | LoadFailureOf<LE> | E
>;
export type DeleteMethod<N extends string, In, Out, P, Act, Pre, A, E, LE> = (
  args: Args<{ readonly id: IdOf<In> }, Act>,
) => Result.ResultAsync<Deletable<Model<N, In, Out, P, Act>, Pre, A>, InputFailure | LoadFailureOf<LE> | E>;

const saveWith = async <Pre, Out, P, Act, A, E>(
  rules: SaveRun<Pre, Out, P, Act, A, E>,
  inv: Invocation,
  pre: Pre | null,
  next: Out,
  input: Partial<Out>,
  actor: Act,
) => {
  const r = await rules.run({ pre, next, input: Object.freeze({ ...input }), actor, now: inv.now }, inv);
  if (r.type === "Failure") return r;
  return Result.succeed({ next: Object.freeze(r.value.next), actor: r.value.actor });
};

const createIn = async <N extends string, In, Out, P, Act, A, E>(
  ctx: BindCtx,
  model: Model<N, In, Out, P, Act>,
  rules: SaveRun<never, Out, P, Act, A, E>,
  input: State,
  actor: Act,
) => {
  const next = await validateWhole(model.schema.input, input);
  if (next.type === "Failure") return next;
  const r = await saveWith(rules, ctx.invocation(), null, next.value, next.value, actor);
  if (r.type === "Failure") return r;
  return Result.succeed(
    seal<"persistable", N, "create", { readonly pre: null; readonly next: Readonly<P>; readonly actor: A }>({
      pre: null,
      ...r.value,
    }),
  );
};

const loadExisting = async <N extends string, In, Out extends { readonly id?: unknown }, P, Act, Pre, LE>(
  ctx: BindCtx,
  model: Model<N, In, Out, P, Act>,
  load: LoadRun<Out, Act, Pre, LE>,
  input: State,
  actor: Act,
) => {
  const validated = await validatePartial(model.schema.input.entries, input);
  if (validated.type === "Failure") return validated;
  const { id } = validated.value;
  if (id === undefined || id === null) return Result.fail(inputFailure([{ message: "id は必須です", path: ["id"] }]));
  const inv = ctx.invocation();
  const pre = await load.run({ input: { ...validated.value, id }, actor }, inv);
  if (pre.type === "Failure") return Result.fail<LoadFailureOf<LE>>({ step: "load", error: pre.error });
  return Result.succeed({ inv, pre: pre.value, validated: validated.value });
};

// 更新では、既存の値に入力を重ねて next にする。既存の値の型は入力の型に代入できるので、重ねた値も入力の型になる
const updateIn = async <N extends string, In, Out extends { readonly id?: unknown }, P, Act, Pre extends Out, LE, A, E>(
  ctx: BindCtx,
  model: Model<N, In, Out, P, Act>,
  load: LoadRun<Out, Act, Pre, LE>,
  rules: SaveRun<Pre, Out, P, Act, A, E>,
  input: State,
  actor: Act,
) => {
  const existing = await loadExisting(ctx, model, load, input, actor);
  if (existing.type === "Failure") return existing;
  const { inv, pre, validated } = existing.value;
  const base: Out = pre;
  const next: Out = { ...base, ...validated };
  const r = await saveWith(rules, inv, pre, next, validated, actor);
  if (r.type === "Failure") return r;
  return Result.succeed(
    seal<"persistable", N, "update", { readonly pre: Readonly<Pre>; readonly next: Readonly<P>; readonly actor: A }>({
      pre: Object.freeze({ ...pre }),
      ...r.value,
    }),
  );
};

export const createMethod =
  <N extends string, In, Out, P, Act, A, E>(
    model: Model<N, In, Out, P, Act>,
    rules: SaveRun<never, Out, P, Act, A, E>,
  ): ((ctx: BindCtx) => CreateMethod<N, In, Out, P, Act, A, E>) =>
  (ctx) =>
  ({ input, actor }) =>
    createIn(ctx, model, rules, input, actor);

export const updateMethod =
  <N extends string, In, Out extends { readonly id?: unknown }, P, Act, Pre extends Out, LE, A, E>(
    model: Model<N, In, Out, P, Act>,
    load: LoadRun<Out, Act, Pre, LE>,
    rules: SaveRun<Pre, Out, P, Act, A, E>,
  ): ((ctx: BindCtx) => UpdateMethod<N, In, Out, P, Act, Pre, A, E, LE>) =>
  (ctx) =>
  ({ input, actor }) =>
    updateIn(ctx, model, load, rules, input, actor);

// input に id がなければ新規作成、あれば更新する
export const upsertMethod =
  <N extends string, In, Out extends { readonly id?: unknown }, P, Act, Pre extends Out, LE, A, E>(
    model: Model<N, In, Out, P, Act>,
    load: LoadRun<Out, Act, Pre, LE>,
    rules: SaveRun<Pre, Out, P, Act, A, E>,
  ): ((ctx: BindCtx) => UpsertMethod<N, In, Out, P, Act, Pre, A, E, LE>) =>
  (ctx) =>
  ({ input, actor }) => {
    const fields: State = input;
    return fields["id"] === undefined
      ? createIn(ctx, model, rules, input, actor)
      : updateIn(ctx, model, load, rules, input, actor);
  };

export const deleteMethod =
  <N extends string, In, Out extends { readonly id?: unknown }, P, Act, Pre extends Out, LE, A, E>(
    model: Model<N, In, Out, P, Act>,
    load: LoadRun<Out, Act, Pre, LE>,
    rules: DeleteRun<Pre, Act, A, E>,
  ): ((ctx: BindCtx) => DeleteMethod<N, In, Out, P, Act, Pre, A, E, LE>) =>
  (ctx) =>
  async ({ input, actor }) => {
    const existing = await loadExisting(ctx, model, load, input, actor);
    if (existing.type === "Failure") return existing;
    const { inv, pre } = existing.value;
    const r = await rules.run({ pre, next: null, actor, now: inv.now }, inv);
    if (r.type === "Failure") return r;
    return Result.succeed(
      seal<"deletable", N, "delete", { readonly pre: Readonly<Pre>; readonly actor: A }>({
        pre: Object.freeze({ ...pre }),
        actor: r.value.actor,
      }),
    );
  };
