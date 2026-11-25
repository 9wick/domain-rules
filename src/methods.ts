import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Action, Actor, DecideState, DeleteState, Entries, Model, ObjectSchema, SaveState } from "./model.ts";
import type { Invocation, Port } from "./port.ts";
import type { Decider } from "./ruleset.ts";
import { seal, type Decision, type Deletable, type Persistable } from "./seal.ts";

type State = Readonly<Record<string, unknown>>;
export type InputFailure = {
  readonly step: "input";
  readonly error: { readonly issues: readonly StandardSchemaV1.Issue[] };
};
export type LoadFailureOf<LE> = { readonly step: "load"; readonly error: "NOT_FOUND" | LE };
type Args<I> = { readonly input: I; readonly actor: Actor };

// bind が rule の組に渡すもの。メソッドを呼ぶたびに、その呼び出しを作る
export type BindCtx = { readonly invocation: () => Invocation };

const inputFailure = (issues: readonly StandardSchemaV1.Issue[]): InputFailure => ({
  step: "input",
  error: { issues },
});

const validate = async <O>(
  schema: StandardSchemaV1<unknown, O>,
  value: unknown,
  path: readonly PropertyKey[] = [],
): Promise<Result.Result<O, StandardSchemaV1.Issue[]>> => {
  const r = await schema["~standard"].validate(value);
  return r.issues !== undefined
    ? Result.fail(r.issues.map((i) => ({ ...i, path: [...path, ...(i.path ?? [])] })))
    : Result.succeed(r.value);
};

const unknownKeys = (entries: object, input: State, allowed: (key: string) => boolean): StandardSchemaV1.Issue[] =>
  Object.keys(input)
    .filter((key) => !Object.hasOwn(entries, key) || !allowed(key))
    .map((key) => ({ message: `schema にない項目です: ${key}`, path: [key] }));

const definedEntries = (input: State): State =>
  Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

const validateWhole = async <Out>(
  schema: ObjectSchema<unknown, Out>,
  input: State,
): Promise<Result.Result<Out, InputFailure>> => {
  const defined = definedEntries(input);
  const unknown = unknownKeys(schema.entries, defined, (key) => key !== "id");
  const r = await validate(schema, defined);
  const issues = [...unknown, ...(Result.isFailure(r) ? r.error : [])];
  if (issues.length > 0 || Result.isFailure(r)) return Result.fail(inputFailure(issues));
  return Result.succeed(r.value);
};

// 更新では入力にある項目だけを、その項目の schema で検証する
const validatePartial = async <Out>(
  entries: Entries<Out>,
  input: State,
): Promise<Result.Result<Partial<Out>, InputFailure>> => {
  const issues = unknownKeys(entries, input, () => true);
  const defined = definedEntries(input);
  const out: Partial<Out> = {};
  for (const key in entries) {
    if (!Object.hasOwn(defined, key)) continue;
    const r = await validate(entries[key], defined[key], [key]);
    if (Result.isFailure(r)) issues.push(...r.error);
    else out[key] = r.value;
  }
  return issues.length > 0 ? Result.fail(inputFailure(issues)) : Result.succeed(out);
};

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
export type SaveRun<Pre, Out, P, A, E> = {
  readonly run: (
    s: SaveState<Pre | null, Out>,
    invocation: Invocation,
  ) => Promise<Result.Result<{ readonly next: P; readonly actor: A }, E>>;
};
export type DeleteRun<Pre, A, E> = {
  readonly run: (s: DeleteState<Pre>, invocation: Invocation) => Promise<Result.Result<{ readonly actor: A }, E>>;
};

type IdOf<In> = NonNullable<Partial<In>["id" & keyof Partial<In>]>;

export type CreateMethod<N extends string, In, Out, P, A, E> = (
  args: Args<Omit<Partial<In>, "id">>,
) => Result.ResultAsync<Persistable<Model<N, In, Out, P>, "create", P, A>, InputFailure | E>;
export type UpdateMethod<N extends string, In, Out, P, Pre, A, E, LE> = (
  args: Args<Partial<In> & { readonly id: IdOf<In> }>,
) => Result.ResultAsync<Persistable<Model<N, In, Out, P>, "update", Pre, A>, InputFailure | LoadFailureOf<LE> | E>;
export type UpsertMethod<N extends string, In, Out, P, Pre, A, E, LE> = (
  args: Args<Partial<In>>,
) => Result.ResultAsync<
  Persistable<Model<N, In, Out, P>, "create" | "update", Pre, A>,
  InputFailure | LoadFailureOf<LE> | E
>;
export type DeleteMethod<N extends string, In, Out, P, Pre, A, E, LE> = (
  args: Args<{ readonly id: IdOf<In> }>,
) => Result.ResultAsync<Deletable<Model<N, In, Out, P>, Pre, A>, InputFailure | LoadFailureOf<LE> | E>;

const saveWith = async <Pre, Out, P, A, E>(
  rules: SaveRun<Pre, Out, P, A, E>,
  inv: Invocation,
  pre: Pre | null,
  next: Out,
  actor: Actor,
) => {
  const r = await rules.run({ pre, next, actor, now: inv.now }, inv);
  if (Result.isFailure(r)) return r;
  return Result.succeed({ next: Object.freeze(r.value.next), actor: r.value.actor });
};

const createIn = async <N extends string, In, Out, P, A, E>(
  ctx: BindCtx,
  model: Model<N, In, Out, P>,
  rules: SaveRun<never, Out, P, A, E>,
  input: State,
  actor: Actor,
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

const loadExisting = async <N extends string, In, Out extends { readonly id?: LA | undefined }, P, LA, LT, LE>(
  ctx: BindCtx,
  model: Model<N, In, Out, P>,
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
  LA,
  LT extends Out | null,
  LE,
  A,
  E,
>(
  ctx: BindCtx,
  model: Model<N, In, Out, P>,
  port: Port<string, [LA], LT, LE>,
  rules: SaveRun<LT & {}, Out, P, A, E>,
  input: State,
  actor: Actor,
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
  <N extends string, In, Out, P, A, E>(
    model: Model<N, In, Out, P>,
    rules: SaveRun<never, Out, P, A, E>,
  ): ((ctx: BindCtx) => CreateMethod<N, In, Out, P, A, E>) =>
  (ctx) =>
  ({ input, actor }) =>
    createIn(ctx, model, rules, input, actor);

export const updateMethod =
  <N extends string, In, Out extends { readonly id?: LA | undefined }, P, LA, LT extends Out | null, LE, A, E>(
    model: Model<N, In, Out, P>,
    port: Port<string, [LA], LT, LE>,
    rules: SaveRun<LT & {}, Out, P, A, E>,
  ): ((ctx: BindCtx) => UpdateMethod<N, In, Out, P, LT & {}, A, E, LE>) =>
  (ctx) =>
  ({ input, actor }) =>
    updateIn(ctx, model, port, rules, input, actor);

// input に id がなければ新規作成、あれば更新する
export const upsertMethod =
  <N extends string, In, Out extends { readonly id?: LA | undefined }, P, LA, LT extends Out | null, LE, A, E>(
    model: Model<N, In, Out, P>,
    port: Port<string, [LA], LT, LE>,
    rules: SaveRun<LT & {}, Out, P, A, E>,
  ): ((ctx: BindCtx) => UpsertMethod<N, In, Out, P, LT & {}, A, E, LE>) =>
  (ctx) =>
  ({ input, actor }) => {
    const fields: State = input;
    return fields["id"] === undefined
      ? createIn(ctx, model, rules, input, actor)
      : updateIn(ctx, model, port, rules, input, actor);
  };

export const deleteMethod =
  <N extends string, In, Out extends { readonly id?: LA | undefined }, P, LA, LT extends Out | null, LE, A, E>(
    model: Model<N, In, Out, P>,
    port: Port<string, [LA], LT, LE>,
    rules: DeleteRun<LT & {}, A, E>,
  ): ((ctx: BindCtx) => DeleteMethod<N, In, Out, P, LT & {}, A, E, LE>) =>
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

export type DecideMethod<N extends string, In, Out, T, A, E> = (
  args: Args<In>,
) => Result.ResultAsync<Decision<Action<N, In, Out>, T, A>, InputFailure | E>;

export const actionMethods = <N extends string, In, Out, T, A, E>(
  ctx: BindCtx,
  input: StandardSchemaV1<In, Out>,
  rules: Decider<DecideState<Out>, { readonly value: T; readonly actor: A }, E, string>,
): { readonly decide: DecideMethod<N, In, Out, T, A, E> } => {
  const decide: DecideMethod<N, In, Out, T, A, E> = async ({ input: value, actor }) => {
    const validated = await validate(input, value);
    if (Result.isFailure(validated)) return Result.fail(inputFailure(validated.error));
    const inv = ctx.invocation();
    const r = await rules.run({ input: validated.value, actor, now: inv.now }, inv);
    if (Result.isFailure(r)) return r;
    return Result.succeed(seal<"decision", N, "decide", { readonly value: T; readonly actor: A }>(r.value));
  };
  return Object.freeze({ decide });
};
