import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Actor, DecideState, DeleteState, Entries, ObjectSchema, SaveState } from "./model.ts";
import type { Port, PortCall } from "./port.ts";
import type { Decider, RunnableRuleset } from "./ruleset.ts";
import { seal } from "./seal.ts";

type State = Readonly<Record<string, unknown>>;
type Failure = { readonly step: string; readonly error: unknown };
type Args<I> = { readonly input: I; readonly actor: Actor };
type Method<I> = (args: Args<I>) => Promise<Result.Result<unknown, unknown>>;

// 1回の呼び出しで使う port の呼び出し方と時刻。bind が provider から作る
export type Invocation = { readonly call: PortCall; readonly now: number };

// rule の組が、bind から受け取った呼び出しの作り方でメソッドを作る。型は rule の組を作るときに決まっているので、ここで型を消さない
export type BuildMethods = (invocation: () => Invocation) => Readonly<Record<string, object>>;

const inputFailure = (issues: readonly StandardSchemaV1.Issue[]): Failure => ({ step: "input", error: { issues } });

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
): Promise<Result.Result<Out, Failure>> => {
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
): Promise<Result.Result<Partial<Out>, Failure>> => {
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
  port: Port<string, readonly [A], V | null, E>,
  id: A,
): Promise<Result.Result<V, Failure>> => {
  const r = await inv.call(port, [id]);
  if (Result.isFailure(r)) return Result.fail({ step: "load", error: r.error });
  return r.value === null ? Result.fail({ step: "load", error: "NOT_FOUND" }) : Result.succeed(r.value);
};

type SaveRules<Pre, Out> = RunnableRuleset<SaveState<Pre | null, Out>, unknown, unknown, string>;
type DeleteRules<Pre> = RunnableRuleset<DeleteState<Pre>, unknown, unknown, string>;

const saveWith = async <Pre, Out>(
  rules: SaveRules<Pre, Out>,
  inv: Invocation,
  pre: Pre | null,
  next: Out,
  actor: Actor,
) => {
  const r = await rules.run({ pre, next, actor, now: inv.now }, inv.call);
  if (Result.isFailure(r)) return r;
  const contents = { pre: pre === null ? null : Object.freeze({ ...pre }), next: Object.freeze(r.value.next) };
  return Result.succeed(seal({ ...contents, actor: r.value.actor }));
};

// 更新では、既存の値に入力を重ねて next にする。既存の値の型は入力の型に代入できるので、重ねた値も入力の型になる
export const modelMethods =
  <LA, Out extends { readonly id?: LA | undefined }, Pre extends Out, LE>(def: {
    readonly schema: ObjectSchema<unknown, Out>;
    readonly load: Port<string, readonly [LA], Pre | null, LE> | undefined;
    readonly save: SaveRules<Pre, Out> | undefined;
    readonly delete: DeleteRules<Pre> | undefined;
  }): BuildMethods =>
  (invocation) => {
    const { schema, load: loadPort, save, delete: del } = def;

    const create =
      (rules: SaveRules<Pre, Out>): Method<State> =>
      async ({ input, actor }) => {
        const next = await validateWhole(schema, input);
        return Result.isFailure(next) ? next : saveWith(rules, invocation(), null, next.value, actor);
      };

    const loadExisting = async (loader: Port<string, readonly [LA], Pre | null, LE>, input: State) => {
      const validated = await validatePartial(schema.entries, input);
      if (Result.isFailure(validated)) return validated;
      const id = validated.value.id;
      if (id === undefined) return Result.fail(inputFailure([{ message: "id は必須です", path: ["id"] }]));
      const inv = invocation();
      const pre = await load(inv, loader, id);
      if (Result.isFailure(pre)) return pre;
      return Result.succeed({ inv, pre: pre.value, validated: validated.value });
    };

    const update =
      (rules: SaveRules<Pre, Out>, loader: Port<string, readonly [LA], Pre | null, LE>): Method<State> =>
      async ({ input, actor }) => {
        const existing = await loadExisting(loader, input);
        if (Result.isFailure(existing)) return existing;
        const { inv, pre, validated } = existing.value;
        const next: Out = { ...pre, ...validated };
        return saveWith(rules, inv, pre, next, actor);
      };

    const upsert =
      (rules: SaveRules<Pre, Out>, loader: Port<string, readonly [LA], Pre | null, LE>): Method<State> =>
      (args) =>
        args.input["id"] === undefined ? create(rules)(args) : update(rules, loader)(args);

    const remove =
      (rules: DeleteRules<Pre>, loader: Port<string, readonly [LA], Pre | null, LE>): Method<State> =>
      async ({ input, actor }) => {
        const existing = await loadExisting(loader, input);
        if (Result.isFailure(existing)) return existing;
        const { inv, pre } = existing.value;
        const r = await rules.run({ pre, next: null, actor, now: inv.now }, inv.call);
        if (Result.isFailure(r)) return r;
        return Result.succeed(seal({ pre: Object.freeze({ ...pre }), actor: r.value.actor }));
      };

    return Object.freeze({
      ...(save !== undefined && { create: create(save) }),
      ...(save !== undefined &&
        loadPort !== undefined && { update: update(save, loadPort), upsert: upsert(save, loadPort) }),
      ...(del !== undefined && loadPort !== undefined && { delete: remove(del, loadPort) }),
    });
  };

export const actionMethods =
  <Out, R>(input: StandardSchemaV1<unknown, Out>, rules: Decider<DecideState<Out>, R, unknown, string>): BuildMethods =>
  (invocation) => {
    const decide: Method<unknown> = async ({ input: value, actor }) => {
      const validated = await validate(input, value);
      if (Result.isFailure(validated)) return Result.fail(inputFailure(validated.error));
      const inv = invocation();
      const r = await rules.run({ input: validated.value, actor, now: inv.now }, inv.call);
      return Result.isFailure(r) ? r : Result.succeed(seal(r.value));
    };
    return Object.freeze({ decide });
  };
