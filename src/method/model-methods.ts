import { Result } from "@praha/byethrow";
import type { DeleteState, Model, SaveState } from "../definition/model.ts";
import type { Invocation } from "../port/invocation.ts";
import type { Port } from "../port/port.ts";
import type { Args, BindCtx } from "./context.ts";
import { seal, type Deletable, type Persistable } from "./seal.ts";
import { inputFailure, validatePartial, validateWhole, type InputFailure, type State } from "./validate.ts";

export type LoadFailureOf<LE> = { readonly step: "load"; readonly error: "NOT_FOUND" | LE };

const load = async <A, V, E>(
  inv: Invocation,
  port: Port<string, [A], V, E>,
  id: A,
): Promise<Result.Result<V & {}, LoadFailureOf<E>>> => {
  const r = await port.callIn(inv, [id]);
  if (Result.isFailure(r)) return Result.fail({ step: "load", error: r.error });
  const existing = r.value;
  return existing === null || existing === undefined
    ? Result.fail({ step: "load", error: "NOT_FOUND" })
    : Result.succeed(existing);
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
  actor: Act,
) => {
  const r = await rules.run({ pre, next, actor, now: inv.now }, inv);
  if (Result.isFailure(r)) return r;
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
  if (Result.isFailure(next)) return next;
  const r = await saveWith(rules, ctx.invocation(), null, next.value, actor);
  if (Result.isFailure(r)) return r;
  return Result.succeed(
    seal<"persistable", N, "create", { readonly pre: null; readonly next: Readonly<P>; readonly actor: A }>({
      pre: null,
      ...r.value,
    }),
  );
};

const loadExisting = async <N extends string, In, Out extends { readonly id?: LA | undefined }, P, Act, LA, LT, LE>(
  ctx: BindCtx,
  model: Model<N, In, Out, P, Act>,
  port: Port<string, [LA], LT, LE>,
  input: State,
) => {
  const validated = await validatePartial(model.schema.input.entries, input);
  if (Result.isFailure(validated)) return validated;
  const id = validated.value.id;
  if (id === undefined) return Result.fail(inputFailure([{ message: "id は必須です", path: ["id"] }]));
  const inv = ctx.invocation();
  const pre = await load(inv, port, id);
  if (Result.isFailure(pre)) return pre;
  return Result.succeed({ inv, pre: pre.value, validated: validated.value });
};

// 更新では、既存の値に入力を重ねて next にする。既存の値の型は入力の型に代入できるので、重ねた値も入力の型になる
const updateIn = async <
  N extends string,
  In,
  Out extends { readonly id?: LA | undefined },
  P,
  Act,
  LA,
  LT extends Out | null,
  LE,
  A,
  E,
>(
  ctx: BindCtx,
  model: Model<N, In, Out, P, Act>,
  port: Port<string, [LA], LT, LE>,
  rules: SaveRun<LT & {}, Out, P, Act, A, E>,
  input: State,
  actor: Act,
) => {
  const existing = await loadExisting(ctx, model, port, input);
  if (Result.isFailure(existing)) return existing;
  const { inv, pre, validated } = existing.value;
  const base: Out = pre;
  const next: Out = { ...base, ...validated };
  const r = await saveWith(rules, inv, pre, next, actor);
  if (Result.isFailure(r)) return r;
  return Result.succeed(
    seal<
      "persistable",
      N,
      "update",
      { readonly pre: Readonly<LT & {}>; readonly next: Readonly<P>; readonly actor: A }
    >({
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
  <N extends string, In, Out extends { readonly id?: LA | undefined }, P, Act, LA, LT extends Out | null, LE, A, E>(
    model: Model<N, In, Out, P, Act>,
    port: Port<string, [LA], LT, LE>,
    rules: SaveRun<LT & {}, Out, P, Act, A, E>,
  ): ((ctx: BindCtx) => UpdateMethod<N, In, Out, P, Act, LT & {}, A, E, LE>) =>
  (ctx) =>
  ({ input, actor }) =>
    updateIn(ctx, model, port, rules, input, actor);

// input に id がなければ新規作成、あれば更新する
export const upsertMethod =
  <N extends string, In, Out extends { readonly id?: LA | undefined }, P, Act, LA, LT extends Out | null, LE, A, E>(
    model: Model<N, In, Out, P, Act>,
    port: Port<string, [LA], LT, LE>,
    rules: SaveRun<LT & {}, Out, P, Act, A, E>,
  ): ((ctx: BindCtx) => UpsertMethod<N, In, Out, P, Act, LT & {}, A, E, LE>) =>
  (ctx) =>
  ({ input, actor }) => {
    const fields: State = input;
    return fields["id"] === undefined
      ? createIn(ctx, model, rules, input, actor)
      : updateIn(ctx, model, port, rules, input, actor);
  };

export const deleteMethod =
  <N extends string, In, Out extends { readonly id?: LA | undefined }, P, Act, LA, LT extends Out | null, LE, A, E>(
    model: Model<N, In, Out, P, Act>,
    port: Port<string, [LA], LT, LE>,
    rules: DeleteRun<LT & {}, Act, A, E>,
  ): ((ctx: BindCtx) => DeleteMethod<N, In, Out, P, Act, LT & {}, A, E, LE>) =>
  (ctx) =>
  async ({ input, actor }) => {
    const existing = await loadExisting(ctx, model, port, input);
    if (Result.isFailure(existing)) return existing;
    const { inv, pre } = existing.value;
    const r = await rules.run({ pre, next: null, actor, now: inv.now }, inv);
    if (Result.isFailure(r)) return r;
    return Result.succeed(
      seal<"deletable", N, "delete", { readonly pre: Readonly<LT & {}>; readonly actor: A }>({
        pre: Object.freeze({ ...pre }),
        actor: r.value.actor,
      }),
    );
  };
