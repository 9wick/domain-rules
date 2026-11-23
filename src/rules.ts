import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Action, Actor, DecideState, DeleteState, Model, Overlay, Persisted, SaveState, Value } from "./model.ts";
import type { Port, PortArgs, PortError, PortValue } from "./port.ts";
import type { Rule } from "./rule.ts";
import { describeWhen, type TrackKind, type WhenDescription } from "./when.ts";

declare const ruleSetTypes: unique symbol;

type RuleInfo<R> = R extends Rule<infer K, infer T, infer N, infer S, infer Out, infer E, infer P, infer A>
  ? { kind: K; target: T; name: N; state: S; out: Out; error: E; ports: P; always: A }
  : never;

type Advance<S, R> = RuleInfo<R>["always"] extends true
  ? Overlay<S, RuleInfo<R>["out"]>
  : S | Overlay<S, RuleInfo<R>["out"]>;

export type RuleMismatch<Name, Need, Have> = {
  readonly "前提の型を満たさない rule": Name;
  readonly 必要な状態: Need;
  readonly 実際の状態: Have;
};
export type TrackMismatch<Name, Expected> = { readonly "線路の種類が違う rule": Name; readonly 期待した線路: Expected };

// 並べた rule を先頭からたどり、各 rule の前提の型を確かめながら状態の型を進める
export type Walk<S, Rs, K extends TrackKind, T extends string, Acc extends readonly unknown[] = []> = Rs extends readonly [
  infer R,
  ...infer Rest,
]
  ? [K, T] extends [RuleInfo<R>["kind"], RuleInfo<R>["target"]]
    ? [S] extends [RuleInfo<R>["state"]]
      ? Walk<Advance<S, R>, Rest, K, T, [...Acc, R]>
      : { readonly rules: readonly [...Acc, RuleMismatch<RuleInfo<R>["name"], RuleInfo<R>["state"], S>, ...Rest]; readonly state: never }
    : { readonly rules: readonly [...Acc, TrackMismatch<RuleInfo<R>["name"], `${T}.${K}`>, ...Rest]; readonly state: never }
  : { readonly rules: Acc; readonly state: S };

export type RuleFailure<Rs> = Rs extends readonly (infer R)[]
  ? R extends unknown
    ? { readonly step: RuleInfo<R>["name"]; readonly error: RuleInfo<R>["error"] }
    : never
  : never;
export type InputFailure = { readonly step: "input"; readonly error: { readonly issues: readonly StandardSchemaV1.Issue[] } };
export type LoadFailure<L> = { readonly step: "load"; readonly error: "NOT_FOUND" | PortError<L> };

type PortNamesOfRules<Rs> = Rs extends readonly (infer R)[]
  ? R extends unknown
    ? { [K in keyof RuleInfo<R>["ports"]]: RuleInfo<R>["ports"][K] extends Port<infer N> ? N : never }[keyof RuleInfo<R>["ports"]]
    : never
  : never;

type AnyLoad = Port<string, readonly [unknown], unknown, unknown>;
type Existing<L> = [L] extends [never] ? never : Exclude<PortValue<L>, null>;
type LoadId<M extends Model> = "id" extends keyof Value<M> ? Exclude<Value<M>["id"], undefined> : never;
type LoadIdMismatch<M extends Model, L> = [LoadId<M>] extends [never]
  ? { readonly "load には入力スキーマの id が要る": true }
  : [LoadId<M>] extends [PortArgs<L>[0]]
    ? unknown
    : { readonly "load が検証済みの id を受け取れない": LoadId<M> };

type LoadMismatch<M extends Model, L> = [L] extends [never]
  ? unknown
  : [PortValue<L>] extends [Persisted<M> | null]
    ? LoadIdMismatch<M, L>
    : { readonly "load の返り値が永続化の型に代入できない": PortValue<L> };

type SaveStart<M extends Model, L> = SaveState<Existing<L> | null, Value<M>>;
type DeleteStart<L> = DeleteState<Existing<L>>;
type SaveWalk<M extends Model, L, Save> = Walk<SaveStart<M, L>, Save, "save", M["name"]>;
type DeleteWalk<M extends Model, L, Del> = Walk<DeleteStart<L>, Del, "delete", M["name"]>;

type PersistedCheck<M extends Model, S> = [S] extends [never]
  ? unknown
  : [S extends { readonly next: infer X } ? X : never] extends [Persisted<M>]
    ? unknown
    : {
        readonly "最後の next が永続化の型にならない": S extends { readonly next: infer X } ? X : never;
        readonly 永続化の型: Persisted<M>;
      };

type ActorOf<S> = [S] extends [never] ? Actor : S extends { readonly actor: infer A } ? A : never;

export type ModelRulesInfo = {
  readonly existing: unknown;
  readonly saveActor: unknown;
  readonly deleteActor: unknown;
  readonly saveFailure: unknown;
  readonly deleteFailure: unknown;
  readonly loadFailure: unknown;
  readonly ports: string;
  readonly methods: "create" | "update" | "upsert" | "delete";
};

export type ModelRules<M extends Model = Model, I extends ModelRulesInfo = any> = {
  readonly kind: "modelRules";
  readonly name: M["name"];
  readonly model: M;
  readonly load: Port | undefined;
  readonly save: readonly Rule[] | undefined;
  readonly delete: readonly Rule[] | undefined;
  readonly [ruleSetTypes]: I;
};

type Methods<L, Save, Del> =
  | ([Save] extends [never] ? never : "create" | ([L] extends [never] ? never : "update" | "upsert"))
  | ([Del] extends [never] ? never : "delete");

export function modelRules<
  M extends Model,
  L extends AnyLoad = never,
  const Save extends readonly Rule[] = never,
  const Del extends readonly Rule[] = never,
>(
  m: M,
  def: {
    readonly load?: L & LoadMismatch<M, L>;
    readonly save?: Save & SaveWalk<M, L, Save>["rules"] & PersistedCheck<M, SaveWalk<M, L, Save>["state"]>;
    readonly delete?: Del &
      DeleteWalk<M, L, Del>["rules"] &
      ([L] extends [never] ? { readonly "delete には load が要る": true } : unknown);
  },
): ModelRules<
  M,
  {
    existing: Existing<L>;
    saveActor: ActorOf<SaveWalk<M, L, Save>["state"]>;
    deleteActor: ActorOf<DeleteWalk<M, L, Del>["state"]>;
    saveFailure: RuleFailure<Save>;
    deleteFailure: RuleFailure<Del>;
    loadFailure: LoadFailure<L>;
    ports: PortNamesOfRules<Save> | PortNamesOfRules<Del> | ([L] extends [never] ? never : L["name"]);
    methods: Methods<L, Save, Del>;
  }
> {
  return Object.freeze({
    kind: "modelRules",
    name: m.name,
    model: m,
    load: def.load,
    save: def.save && Object.freeze([...def.save]),
    delete: def.delete && Object.freeze([...def.delete]),
  }) as unknown as ModelRules<M, any>;
}

export type ActionRulesInfo = { readonly actor: unknown; readonly failure: unknown; readonly ports: string; readonly output: unknown };

export type ActionRules<A extends Action = Action, I extends ActionRulesInfo = any> = {
  readonly kind: "actionRules";
  readonly name: A["name"];
  readonly action: A;
  readonly rules: readonly Rule[];
  readonly output: ((s: any) => unknown) | undefined;
  readonly [ruleSetTypes]: I;
};

type DecideWalk<A extends Action, Rs> = Walk<DecideState<StandardSchemaV1.InferOutput<A["input"]>>, Rs, "decide", A["name"]>;

export function actionRules<A extends Action, const Rs extends readonly Rule[], T = void>(
  a: A,
  def: {
    readonly rules: Rs & DecideWalk<A, Rs>["rules"];
    readonly output?: (s: DecideWalk<A, Rs>["state"]) => T;
  },
): ActionRules<A, { actor: ActorOf<DecideWalk<A, Rs>["state"]>; failure: RuleFailure<Rs>; ports: PortNamesOfRules<Rs>; output: T }> {
  return Object.freeze({ kind: "actionRules", name: a.name, action: a, rules: Object.freeze([...def.rules]), output: def.output }) as unknown as ActionRules<A, any>;
}

export type RuleSet = ModelRules | ActionRules;
export type RuleSetInfo<S> = S extends { readonly [ruleSetTypes]: infer I } ? I : never;

export type PlannedRule = { readonly name: string; readonly when: WhenDescription; readonly ports: readonly string[] };

const planRules = (rules: readonly Rule[]): readonly PlannedRule[] =>
  rules.map((r) => ({ name: r.name, when: describeWhen(r.when), ports: Object.values(r.requires).map((p) => (p as Port).name) }));

export function plan(set: ModelRules): { readonly save?: readonly PlannedRule[]; readonly delete?: readonly PlannedRule[] };
export function plan(set: ActionRules): { readonly rules: readonly PlannedRule[] };
export function plan(set: RuleSet) {
  if (set.kind === "actionRules") return { rules: planRules(set.rules) };
  return {
    ...(set.save && { save: planRules(set.save) }),
    ...(set.delete && { delete: planRules(set.delete) }),
  };
}
