import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { assembled, callErased, type ErasedFn } from "./erased.ts";
import type { Action, Actor, InputOf, Model, ObjectSchema } from "./model.ts";
import { clock, portCaller, runWithPorts, type Clock, type Port, type PortCall, type Provider } from "./port.ts";
import type { Rule } from "./rule.ts";
import type { ActionRules, InputFailure, ModelRules, RuleSet, RuleSetInfo } from "./rules.ts";
import { seal, type Decision, type Deletable, type Persistable } from "./seal.ts";

type State = Readonly<Record<string, unknown>>;
type Failure = { readonly step: string; readonly error: unknown };

type Id<M extends Model> = NonNullable<InputOf<M>["id" & keyof InputOf<M>]>;
type Args<I> = { readonly input: I; readonly actor: Actor };

type ModelMethods<M extends Model, I> = I extends {
  existing: infer X;
  saveActor: infer SA;
  deleteActor: infer DA;
  saveFailure: infer SF;
  deleteFailure: infer DF;
  loadFailure: infer LF;
  methods: infer Ms;
}
  ? Pick<
      {
        create: (
          args: Args<Omit<InputOf<M>, "id">>,
        ) => Result.ResultAsync<Persistable<M, "create", X, SA>, InputFailure | SF>;
        update: (
          args: Args<InputOf<M> & { readonly id: Id<M> }>,
        ) => Result.ResultAsync<Persistable<M, "update", X, SA>, InputFailure | LF | SF>;
        upsert: (
          args: Args<InputOf<M>>,
        ) => Result.ResultAsync<
          Persistable<M, "create", X, SA> | Persistable<M, "update", X, SA>,
          InputFailure | LF | SF
        >;
        delete: (args: Args<{ readonly id: Id<M> }>) => Result.ResultAsync<Deletable<M, X, DA>, InputFailure | LF | DF>;
      },
      Ms & ("create" | "update" | "upsert" | "delete")
    >
  : never;

type ActionMethods<A extends Action, I> = I extends { actor: infer Ac; failure: infer F; output: infer T }
  ? {
      decide: (
        args: Args<StandardSchemaV1.InferInput<A["input"]>>,
      ) => Result.ResultAsync<Decision<A, T, Ac>, InputFailure | F>;
    }
  : never;

type MethodsOf<S> =
  S extends ModelRules<infer M>
    ? ModelMethods<M, RuleSetInfo<S>>
    : S extends ActionRules<infer A>
      ? ActionMethods<A, RuleSetInfo<S>>
      : never;

export type Bound<Sets extends readonly RuleSet[]> = { readonly [S in Sets[number] as S["name"]]: MethodsOf<S> };

type RequiredPorts<Sets extends readonly RuleSet[]> = RuleSetInfo<Sets[number]>["ports"] | "clock";
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
  const impls = new Map<symbol, ErasedFn>();
  for (const p of options.providers) {
    if (impls.has(p.token)) throw new Error(`bind: port "${p.name}" の provider が重複しています`);
    impls.set(p.token, p.impl);
  }
  const bound: Record<string, unknown> = {};
  for (const set of sets) {
    if (Object.hasOwn(bound, set.name)) throw new Error(`bind: "${set.name}" の rule の組が重複しています`);
    const missing = requiredPorts(set)
      .filter((port) => !impls.has(port.token))
      .map((port) => port.name);
    if (missing.length > 0) throw new Error(`bind: provider が足りない port: ${missing.join(", ")}`);
    bound[set.name] = set.kind === "modelRules" ? modelMethods(set, impls) : actionMethods(set, impls);
  }
  return assembled<Bound<Sets>>(bound);
}

const requiredPorts = (set: RuleSet): (Port | Clock)[] => {
  const rules = set.kind === "modelRules" ? [...(set.save ?? []), ...(set.delete ?? [])] : set.rules;
  const load = set.kind === "modelRules" && set.load ? [set.load] : [];
  return [clock, ...load, ...rules.flatMap((r) => Object.values<Port>(r.requires))];
};

type Invocation = { readonly call: PortCall; readonly now: number };

const invocation = (impls: ReadonlyMap<symbol, ErasedFn>): Invocation => {
  const clockImpl = impls.get(clock.token);
  const now = clockImpl === undefined ? undefined : callErased(clockImpl);
  // bind が clock の provider を確かめ、provide の型が数を返すことを確かめているので、ここに来るのは壊れたときだけ
  if (typeof now !== "number") throw new Error("bind: clock の provider が時刻の数を返しませんでした");
  return { call: portCaller(impls), now };
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

const load = async (inv: Invocation, port: Port, id: unknown): Promise<Result.Result<State, Failure>> => {
  const r = await inv.call(port, [id]);
  if (Result.isFailure(r)) return Result.fail({ step: "load", error: r.error });
  const existing = toState(r.value);
  return existing === undefined ? Result.fail({ step: "load", error: "NOT_FOUND" }) : Result.succeed(existing);
};

const overlay = (state: State, value: unknown): State => {
  const v = toState(value);
  if (v === undefined) return state;
  const current = toState(state["next"]);
  const added = toState(v["next"]);
  return current !== undefined && added !== undefined
    ? { ...state, ...v, next: { ...current, ...added } }
    : { ...state, ...v };
};

const runRules = async (
  inv: Invocation,
  rules: readonly Rule[],
  start: State,
): Promise<Result.Result<State, Failure>> => {
  let state = start;
  for (const r of rules) {
    if (!callErased(r.when, state)) continue;
    const s = state;
    const result = await runWithPorts(inv.call, r.requires, (fns) => callErased(r.check, s, fns));
    if (Result.isFailure(result)) return Result.fail({ step: r.name, error: result.error });
    state = overlay(state, result.value);
  }
  return Result.succeed(state);
};

const freezeState = (value: unknown): State | null => {
  const state = toState(value);
  return state === undefined ? null : Object.freeze(state);
};

const sealSave = (state: State) =>
  seal({
    pre: freezeState(state["pre"]),
    next: Object.freeze(toState(state["next"]) ?? {}),
    actor: state["actor"],
  });

const saveWith =
  (rules: readonly Rule[]) => async (inv: Invocation, pre: State | null, next: State, actor: unknown) => {
    const r = await runRules(inv, rules, { pre, next, actor, now: inv.now });
    return Result.isFailure(r) ? r : Result.succeed(sealSave(r.value));
  };

type Run = (args: Args<State>) => Promise<Result.Result<unknown, unknown>>;

const modelMethods = (set: ModelRules, impls: ReadonlyMap<symbol, ErasedFn>) => {
  const { save, delete: del, load: loadPort, model } = set;
  const schema = model.schema.input;

  const create =
    (rules: readonly Rule[]): Run =>
    async ({ input, actor }) => {
      const next = await validateWhole(schema, input);
      return Result.isFailure(next) ? next : saveWith(rules)(invocation(impls), null, next.value, actor);
    };

  const loadExisting = (loader: Port) => async (input: State) => {
    const validated = await validatePartial(schema, input);
    if (Result.isFailure(validated)) return validated;
    const id = requireId(validated.value);
    if (Result.isFailure(id)) return id;
    const inv = invocation(impls);
    const pre = await load(inv, loader, id.value);
    if (Result.isFailure(pre)) return pre;
    return Result.succeed({ inv, pre: pre.value, validated: validated.value });
  };

  const update =
    (rules: readonly Rule[], loader: Port): Run =>
    async ({ input, actor }) => {
      const existing = await loadExisting(loader)(input);
      if (Result.isFailure(existing)) return existing;
      const { inv, pre, validated } = existing.value;
      return saveWith(rules)(inv, pre, { ...pre, ...validated }, actor);
    };

  const upsert =
    (rules: readonly Rule[], loader: Port): Run =>
    (args) =>
      args.input["id"] === undefined ? create(rules)(args) : update(rules, loader)(args);

  const remove =
    (rules: readonly Rule[], loader: Port): Run =>
    async ({ input, actor }) => {
      const existing = await loadExisting(loader)(input);
      if (Result.isFailure(existing)) return existing;
      const { inv, pre } = existing.value;
      const r = await runRules(inv, rules, { pre, next: null, actor, now: inv.now });
      return Result.isFailure(r)
        ? r
        : Result.succeed(seal({ pre: Object.freeze(toState(r.value["pre"]) ?? {}), actor: r.value["actor"] }));
    };

  return Object.freeze({
    ...(save !== undefined && { create: create(save) }),
    ...(save !== undefined &&
      loadPort !== undefined && { update: update(save, loadPort), upsert: upsert(save, loadPort) }),
    ...(del !== undefined && loadPort !== undefined && { delete: remove(del, loadPort) }),
  });
};

const actionMethods = (set: ActionRules, impls: ReadonlyMap<symbol, ErasedFn>) => {
  const decide = async ({ input, actor }: Args<unknown>) => {
    const validated = await validate(set.action.input, input);
    if (Result.isFailure(validated)) return Result.fail(inputFailure(validated.error));
    const inv = invocation(impls);
    const r = await runRules(inv, set.rules, { input: validated.value, actor, now: inv.now });
    if (Result.isFailure(r)) return r;
    return Result.succeed(
      seal({ value: set.output === undefined ? undefined : callErased(set.output, r.value), actor: r.value["actor"] }),
    );
  };
  return Object.freeze({ decide });
};
