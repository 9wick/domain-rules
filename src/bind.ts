import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Action, Actor, InputOf, Model, ObjectSchema } from "./model.ts";
import { clock, portCaller, type Impls, type Port, type PortCall, type Provider } from "./port.ts";
import type {
  ActionRules,
  AnyRunnable,
  Existing,
  InputFailure,
  LoadFailure,
  DeleteEnd,
  ModelRules,
  RuleSet,
  SaveEnd,
  RuleSetPorts,
} from "./rules.ts";
import type { Decider, RulesetError } from "./ruleset.ts";
import { seal, type Decision, type Deletable, type Persistable } from "./seal.ts";
import { boundOf, runErased } from "./unchecked.ts";

type State = Readonly<Record<string, unknown>>;
type Failure = { readonly step: string; readonly error: unknown };

type Id<M extends Model> = NonNullable<InputOf<M>["id" & keyof InputOf<M>]>;
type Args<I> = { readonly input: I; readonly actor: Actor };

type OutOf<R> = R extends Decider<never, infer O, unknown, string> ? O : never;
type ErrorOf<R> =
  R extends Decider<never, unknown, infer E, string> ? E : R extends AnyRunnable ? RulesetError<R> : never;
type ActorOf<S> = S extends { readonly actor: infer A } ? A : never;

type SaveMethods<M extends Model, L, Save> = [Save] extends [undefined]
  ? unknown
  : {
      readonly create: (
        args: Args<Omit<InputOf<M>, "id">>,
      ) => Result.ResultAsync<
        Persistable<M, "create", Existing<L>, ActorOf<SaveEnd<M, L, Save>>>,
        InputFailure | ErrorOf<Save>
      >;
    } & ([L] extends [never]
      ? unknown
      : {
          readonly update: (
            args: Args<InputOf<M> & { readonly id: Id<M> }>,
          ) => Result.ResultAsync<
            Persistable<M, "update", Existing<L>, ActorOf<SaveEnd<M, L, Save>>>,
            InputFailure | LoadFailure<L> | ErrorOf<Save>
          >;
          readonly upsert: (
            args: Args<InputOf<M>>,
          ) => Result.ResultAsync<
            Persistable<M, "create" | "update", Existing<L>, ActorOf<SaveEnd<M, L, Save>>>,
            InputFailure | LoadFailure<L> | ErrorOf<Save>
          >;
        });

type DeleteMethods<M extends Model, L, Del> = [Del] extends [undefined]
  ? unknown
  : [L] extends [never]
    ? unknown
    : {
        readonly delete: (
          args: Args<{ readonly id: Id<M> }>,
        ) => Result.ResultAsync<
          Deletable<M, Existing<L>, ActorOf<DeleteEnd<L, Del>>>,
          InputFailure | LoadFailure<L> | ErrorOf<Del>
        >;
      };

type MethodsOf<S> =
  S extends ModelRules<infer M, infer L, infer Save, infer Del>
    ? SaveMethods<M, L, Save> & DeleteMethods<M, L, Del>
    : S extends ActionRules<infer A, infer Rs>
      ? {
          readonly decide: (
            args: Args<StandardSchemaV1.InferInput<A["input"]>>,
          ) => Result.ResultAsync<
            Decision<A, OutOf<Rs> extends { readonly value: infer T } ? T : never, ActorOf<OutOf<Rs>>>,
            InputFailure | ErrorOf<Rs>
          >;
        }
      : never;

export type Bound<Sets extends readonly RuleSet[]> = { readonly [S in Sets[number] as S["name"]]: MethodsOf<S> };

type RequiredPorts<Sets extends readonly RuleSet[]> = RuleSetPorts<Sets[number]> | "clock";
type MissingProviders<Sets extends readonly RuleSet[], Ps extends readonly Provider[]> = Exclude<
  RequiredPorts<Sets>,
  Ps[number]["name"]
>;

export function bind<const Sets extends readonly RuleSet[], const Ps extends readonly Provider[]>(
  sets: Sets,
  options: { readonly providers: Ps } & ([MissingProviders<Sets, Ps>] extends [never]
    ? unknown
    : { readonly "provider が足りない port": MissingProviders<Sets, Ps> }),
): Bound<Sets> {
  const impls = new Map<symbol, (...args: never) => unknown>();
  let now: (() => number) | undefined;
  for (const p of options.providers) {
    if (impls.has(p.token)) throw new Error(`bind: port "${p.name}" の provider が重複しています`);
    impls.set(p.token, p.kind === "clock" ? p.now : p.impl);
    if (p.kind === "clock") now = p.now;
  }
  const env: Env = { impls, now };
  const bound: Record<string, object> = {};
  for (const set of sets) {
    if (Object.hasOwn(bound, set.name)) throw new Error(`bind: "${set.name}" の rule の組が重複しています`);
    const missing = requiredPorts(set)
      .filter((port) => !impls.has(port.token))
      .map((port) => port.name);
    if (missing.length > 0) throw new Error(`bind: provider が足りない port: ${missing.join(", ")}`);
    bound[set.name] = set.kind === "modelRules" ? modelMethods(set, env) : actionMethods(set, env);
  }
  return boundOf(sets, bound);
}

const requiredPorts = (set: RuleSet): readonly { readonly name: string; readonly token: symbol }[] => {
  const rulesets = set.kind === "modelRules" ? [set.save, set.delete] : [set.rules];
  const load = set.kind === "modelRules" && set.load !== undefined ? [set.load] : [];
  return [clock, ...load, ...rulesets.flatMap((r) => r?.ports ?? [])];
};

type Invocation = { readonly call: PortCall; readonly now: number };

// provider の実装と時計。時計は時刻を返す関数のまま持つ
type Env = { readonly impls: Impls; readonly now: (() => number) | undefined };

const invocation = (env: Env): Invocation => {
  const now = env.now?.();
  // bind が clock の provider を確かめてから呼ぶので、ここに来るのは壊れたときだけ
  if (now === undefined) throw new Error("bind: clock の provider がありません");
  return { call: portCaller(env.impls), now };
};

// schema や provider が返した object を、項目名で引ける状態として読む
const toState = (value: unknown): State | undefined =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : undefined;

const inputFailure = (issues: readonly StandardSchemaV1.Issue[]): Failure => ({ step: "input", error: { issues } });

const validate = async (schema: StandardSchemaV1, value: unknown, path: readonly PropertyKey[] = []) => {
  const r = await schema["~standard"].validate(value);
  return r.issues !== undefined
    ? Result.fail(r.issues.map((i) => ({ ...i, path: [...path, ...(i.path ?? [])] })))
    : Result.succeed(r.value);
};

const unknownKeys = (schema: ObjectSchema, input: State, allowed: (key: string) => boolean): StandardSchemaV1.Issue[] =>
  Object.keys(input)
    .filter((key) => !Object.hasOwn(schema.entries, key) || !allowed(key))
    .map((key) => ({ message: `schema にない項目です: ${key}`, path: [key] }));

const definedEntries = (input: State) => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

const validateWhole = async (schema: ObjectSchema, input: State): Promise<Result.Result<State, Failure>> => {
  const defined = definedEntries(input);
  const unknown = unknownKeys(schema, defined, (key) => key !== "id");
  const r = await validate(schema, defined);
  const issues = [...unknown, ...(Result.isFailure(r) ? r.error : [])];
  const value = Result.isFailure(r) ? undefined : toState(r.value);
  return issues.length > 0 || value === undefined ? Result.fail(inputFailure(issues)) : Result.succeed(value);
};

// 更新では入力にある項目だけを、その項目の schema で検証する
const validatePartial = async (schema: ObjectSchema, input: State): Promise<Result.Result<State, Failure>> => {
  const issues = unknownKeys(schema, input, () => true);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(definedEntries(input))) {
    const entry = Object.hasOwn(schema.entries, key) ? schema.entries[key] : undefined;
    if (entry === undefined) continue;
    const r = await validate(entry, value, [key]);
    if (Result.isFailure(r)) issues.push(...r.error);
    else out[key] = r.value;
  }
  return issues.length > 0 ? Result.fail(inputFailure(issues)) : Result.succeed(out);
};

const requireId = (input: State): Result.Result<unknown, Failure> =>
  input["id"] === undefined
    ? Result.fail(inputFailure([{ message: "id は必須です", path: ["id"] }]))
    : Result.succeed(input["id"]);

const load = async (
  inv: Invocation,
  port: Port<string, readonly [unknown]>,
  id: unknown,
): Promise<Result.Result<State, Failure>> => {
  const r = await inv.call(port, [id]);
  if (Result.isFailure(r)) return Result.fail({ step: "load", error: r.error });
  const existing = toState(r.value);
  return existing === undefined ? Result.fail({ step: "load", error: "NOT_FOUND" }) : Result.succeed(existing);
};

const frozen = (value: unknown): State => Object.freeze(toState(value) ?? {});

type Run = (args: Args<State>) => Promise<Result.Result<unknown, unknown>>;

const saveWith =
  (rules: AnyRunnable) =>
  async (inv: Invocation, pre: State | null, next: State, actor: unknown, op: "create" | "update") => {
    const r = await runErased(rules)({ pre, next, actor, now: inv.now }, inv.call);
    if (Result.isFailure(r)) return r;
    const end = toState(r.value) ?? {};
    return Result.succeed(
      seal<"persistable", string, typeof op, unknown>({
        pre: pre === null ? null : Object.freeze({ ...pre }),
        next: frozen(end["next"]),
        actor: end["actor"],
      }),
    );
  };

const modelMethods = (set: ModelRules, env: Env) => {
  const { save, delete: del, load: loadPort, model } = set;
  const schema = model.schema.input;

  const create =
    (rules: AnyRunnable): Run =>
    async ({ input, actor }) => {
      const next = await validateWhole(schema, input);
      return Result.isFailure(next) ? next : saveWith(rules)(invocation(env), null, next.value, actor, "create");
    };

  const loadExisting = (loader: Port<string, readonly [unknown]>) => async (input: State) => {
    const validated = await validatePartial(schema, input);
    if (Result.isFailure(validated)) return validated;
    const id = requireId(validated.value);
    if (Result.isFailure(id)) return id;
    const inv = invocation(env);
    const pre = await load(inv, loader, id.value);
    if (Result.isFailure(pre)) return pre;
    return Result.succeed({ inv, pre: pre.value, validated: validated.value });
  };

  const update =
    (rules: AnyRunnable, loader: Port<string, readonly [unknown]>): Run =>
    async ({ input, actor }) => {
      const existing = await loadExisting(loader)(input);
      if (Result.isFailure(existing)) return existing;
      const { inv, pre, validated } = existing.value;
      return saveWith(rules)(inv, pre, { ...pre, ...validated }, actor, "update");
    };

  const upsert =
    (rules: AnyRunnable, loader: Port<string, readonly [unknown]>): Run =>
    (args) =>
      args.input["id"] === undefined ? create(rules)(args) : update(rules, loader)(args);

  const remove =
    (rules: AnyRunnable, loader: Port<string, readonly [unknown]>): Run =>
    async ({ input, actor }) => {
      const existing = await loadExisting(loader)(input);
      if (Result.isFailure(existing)) return existing;
      const { inv, pre } = existing.value;
      const r = await runErased(rules)({ pre, next: null, actor, now: inv.now }, inv.call);
      if (Result.isFailure(r)) return r;
      const end = toState(r.value) ?? {};
      return Result.succeed(seal<"deletable", string, "delete", unknown>({ pre: frozen(pre), actor: end["actor"] }));
    };

  return Object.freeze({
    ...(save !== undefined && { create: create(save) }),
    ...(save !== undefined &&
      loadPort !== undefined && { update: update(save, loadPort), upsert: upsert(save, loadPort) }),
    ...(del !== undefined && loadPort !== undefined && { delete: remove(del, loadPort) }),
  });
};

const actionMethods = (set: ActionRules, env: Env) => {
  const decide = async ({ input, actor }: Args<unknown>) => {
    const validated = await validate(set.action.input, input);
    if (Result.isFailure(validated)) return Result.fail(inputFailure(validated.error));
    const inv = invocation(env);
    const r = await runErased(set.rules)({ input: validated.value, actor, now: inv.now }, inv.call);
    if (Result.isFailure(r)) return r;
    return Result.succeed(seal<"decision", string, "decide", unknown>(r.value));
  };
  return Object.freeze({ decide });
};

export type { Action };
