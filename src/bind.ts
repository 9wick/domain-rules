import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Action, Actor, InputOf, Model } from "./model.ts";
import { clock, type Invocation, type Provider } from "./port.ts";
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
import type { Decision, Deletable, Persistable } from "./seal.ts";
import { boundOf } from "./unchecked.ts";

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
  const scope = {};
  for (const p of options.providers) p.registerIn(scope);
  const bound: Record<string, object> = {};
  for (const set of sets) {
    if (Object.hasOwn(bound, set.name)) throw new Error(`bind: "${set.name}" の rule の組が重複しています`);
    const missing = requiredPorts(set)
      .filter((port) => !port.providedIn(scope))
      .map((port) => port.name);
    if (missing.length > 0) throw new Error(`bind: provider が足りない port: ${missing.join(", ")}`);
    bound[set.name] = set.methods(() => invocation(scope));
  }
  return boundOf(sets, bound);
}

const requiredPorts = (
  set: RuleSet,
): readonly { readonly name: string; readonly providedIn: (scope: object) => boolean }[] => {
  const rulesets = set.kind === "modelRules" ? [set.save, set.delete] : [set.rules];
  const load = set.kind === "modelRules" && set.load !== undefined ? [set.load] : [];
  return [clock, ...load, ...rulesets.flatMap((r) => r?.ports ?? [])];
};

const invocation = (scope: object): Invocation => {
  const now = clock.nowIn(scope);
  // bind が clock の provider を確かめてから呼ぶので、ここに来るのは壊れたときだけ
  if (now === undefined) throw new Error("bind: clock の provider がありません");
  return { scope, now };
};

export type { Action };
