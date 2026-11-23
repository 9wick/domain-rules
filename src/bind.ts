import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Action, Actor, InputOf, Model, ObjectSchema } from "./model.ts";
import { catchPortFailure, portCaller, portFns, type Port, type PortCall, type Provider } from "./port.ts";
import type { Rule } from "./rule.ts";
import type { ActionRules, InputFailure, ModelRules, RuleSet, RuleSetInfo } from "./rules.ts";
import { seal, type Decision, type Deletable, type Persistable } from "./seal.ts";

type State = Record<string, unknown>;
type Failure = { readonly step: string; readonly error: unknown };

type Id<M extends Model> = NonNullable<InputOf<M>["id" & keyof InputOf<M>]>;
type Args<I> = { readonly input: I; readonly actor: Actor };
type Run<T, E> = (args: any) => Result.ResultAsync<T, E>;

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
        create: (args: Args<Omit<InputOf<M>, "id">>) => Result.ResultAsync<Persistable<M, "create", X, SA>, InputFailure | SF>;
        update: (
          args: Args<InputOf<M> & { readonly id: Id<M> }>,
        ) => Result.ResultAsync<Persistable<M, "update", X, SA>, InputFailure | LF | SF>;
        upsert: (
          args: Args<InputOf<M>>,
        ) => Result.ResultAsync<Persistable<M, "create", X, SA> | Persistable<M, "update", X, SA>, InputFailure | LF | SF>;
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

type MethodsOf<S> = S extends ModelRules<infer M>
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
  const impls = new Map<string, (...args: any[]) => unknown>();
  for (const p of options.providers) {
    if (impls.has(p.name)) throw new Error(`bind: port "${p.name}" の provider が重複しています`);
    impls.set(p.name, p.impl);
  }
  const bound: Record<string, unknown> = {};
  for (const set of sets) {
    if (set.name in bound) throw new Error(`bind: "${set.name}" の rule の組が重複しています`);
    const missing = requiredPorts(set).filter((name) => !impls.has(name));
    if (missing.length > 0) throw new Error(`bind: provider が足りない port: ${missing.join(", ")}`);
    bound[set.name] = set.kind === "modelRules" ? modelMethods(set, impls) : actionMethods(set, impls);
  }
  return bound as Bound<Sets>;
}

const requiredPorts = (set: RuleSet): string[] => {
  const rules = set.kind === "modelRules" ? [...(set.save ?? []), ...(set.delete ?? [])] : set.rules;
  const load = set.kind === "modelRules" && set.load ? [set.load.name] : [];
  return ["clock", ...load, ...rules.flatMap((r) => Object.values(r.requires).map((p) => (p as Port).name))];
};

type Invocation = { readonly call: PortCall; readonly now: number };

const invocation = (impls: ReadonlyMap<string, (...args: any[]) => unknown>): Invocation => ({
  call: portCaller(impls),
  now: impls.get("clock")!() as number,
});

const inputFailure = (issues: readonly StandardSchemaV1.Issue[]): Failure => ({ step: "input", error: { issues } });

const validate = async (schema: StandardSchemaV1, value: unknown, path: readonly PropertyKey[] = []) => {
  const r = await schema["~standard"].validate(value);
  return r.issues
    ? Result.fail(r.issues.map((i) => ({ ...i, path: [...path, ...(i.path ?? [])] })))
    : Result.succeed(r.value);
};

const unknownKeys = (schema: ObjectSchema, input: State, allowed: (key: string) => boolean): StandardSchemaV1.Issue[] =>
  Object.keys(input)
    .filter((key) => !(key in schema.entries) || !allowed(key))
    .map((key) => ({ message: `schema にない項目です: ${key}`, path: [key] }));

const definedEntries = (input: State) => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

const validateWhole = async (schema: ObjectSchema, input: State): Promise<Result.Result<State, Failure>> => {
  const defined = definedEntries(input);
  const unknown = unknownKeys(schema, defined, (key) => key !== "id");
  if (unknown.length > 0) return Result.fail(inputFailure(unknown));
  const r = await validate(schema, defined);
  return Result.isFailure(r) ? Result.fail(inputFailure(r.error)) : Result.succeed(r.value as State);
};

// 更新では入力にある項目だけを、その項目の schema で検証する
const validatePartial = async (schema: ObjectSchema, input: State): Promise<Result.Result<State, Failure>> => {
  const issues = unknownKeys(schema, input, () => true);
  const out: State = {};
  for (const [key, value] of Object.entries(definedEntries(input))) {
    const entry = schema.entries[key];
    if (!entry) continue;
    const r = await validate(entry, value, [key]);
    if (Result.isFailure(r)) issues.push(...r.error);
    else out[key] = r.value;
  }
  return issues.length > 0 ? Result.fail(inputFailure(issues)) : Result.succeed(out);
};

const requireId = (input: State): Result.Result<unknown, Failure> =>
  input.id === undefined ? Result.fail(inputFailure([{ message: "id は必須です", path: ["id"] }])) : Result.succeed(input.id);

const load = async (inv: Invocation, port: Port, id: unknown): Promise<Result.Result<State, Failure>> => {
  const r = await inv.call(port, [id]);
  if (Result.isFailure(r)) return Result.fail({ step: "load", error: r.error });
  return r.value === null ? Result.fail({ step: "load", error: "NOT_FOUND" }) : Result.succeed({ ...(r.value as State) });
};

const overlay = (state: State, value: unknown): State => {
  if (value === undefined || value === null) return state;
  const v = value as State;
  return "next" in v && typeof state.next === "object" && state.next !== null
    ? { ...state, ...v, next: { ...state.next, ...(v.next as State) } }
    : { ...state, ...v };
};

const runRules = async (inv: Invocation, rules: readonly Rule[], start: State): Promise<Result.Result<State, Failure>> => {
  let state = start;
  for (const r of rules) {
    if (!r.when(state)) continue;
    const s = state;
    const outcome = await catchPortFailure(async () => (await r.check(s, portFns(inv.call, r.requires))) as Result.Result<unknown, unknown>);
    const result = Result.isSuccess(outcome) ? outcome.value : outcome;
    if (Result.isFailure(result)) return Result.fail({ step: r.name, error: result.error });
    state = overlay(state, result.value);
  }
  return Result.succeed(state);
};

const sealSave = (state: State) =>
  seal({ pre: state.pre === null ? null : Object.freeze(state.pre as State), next: Object.freeze(state.next as State), actor: state.actor } as never);

const modelMethods = (set: ModelRules, impls: ReadonlyMap<string, (...args: any[]) => unknown>) => {
  const { save, delete: del, load: loadPort, model } = set;
  const schema = model.schema.input as ObjectSchema;

  const saveWith = async (inv: Invocation, pre: State | null, next: State, actor: unknown) => {
    const r = await runRules(inv, save!, { pre, next, actor, now: inv.now });
    return Result.isFailure(r) ? r : Result.succeed(sealSave(r.value));
  };

  const create = async ({ input, actor }: Args<State>) => {
    const inv = invocation(impls);
    const next = await validateWhole(schema, input);
    return Result.isFailure(next) ? next : saveWith(inv, null, next.value, actor);
  };

  const update = async ({ input, actor }: Args<State>) => {
    const inv = invocation(impls);
    const validated = await validatePartial(schema, input);
    if (Result.isFailure(validated)) return validated;
    const id = requireId(validated.value);
    if (Result.isFailure(id)) return id;
    const pre = await load(inv, loadPort!, id.value);
    if (Result.isFailure(pre)) return pre;
    return saveWith(inv, pre.value, { ...pre.value, ...validated.value }, actor);
  };

  const upsert = (args: Args<State>) => (args.input.id === undefined ? create(args) : update(args));

  const remove = async ({ input, actor }: Args<State>) => {
    const inv = invocation(impls);
    const validated = await validatePartial(schema, input);
    if (Result.isFailure(validated)) return validated;
    const id = requireId(validated.value);
    if (Result.isFailure(id)) return id;
    const pre = await load(inv, loadPort!, id.value);
    if (Result.isFailure(pre)) return pre;
    const r = await runRules(inv, del!, { pre: pre.value, next: null, actor, now: inv.now });
    return Result.isFailure(r) ? r : Result.succeed(seal({ pre: Object.freeze(r.value.pre as State), actor: r.value.actor } as never));
  };

  return Object.freeze({
    ...(save && { create }),
    ...(save && loadPort && { update, upsert }),
    ...(del && loadPort && { delete: remove }),
  }) satisfies Record<string, Run<unknown, unknown>>;
};

const actionMethods = (set: ActionRules, impls: ReadonlyMap<string, (...args: any[]) => unknown>) => {
  const decide = async ({ input, actor }: Args<unknown>) => {
    const inv = invocation(impls);
    const validated = await validate(set.action.input, input);
    if (Result.isFailure(validated)) return Result.fail(inputFailure(validated.error));
    const r = await runRules(inv, set.rules, { input: validated.value, actor, now: inv.now });
    if (Result.isFailure(r)) return r;
    return Result.succeed(seal({ value: set.output?.(r.value), actor: r.value.actor } as never));
  };
  return Object.freeze({ decide });
};
