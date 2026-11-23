import { Result } from "@praha/byethrow";
import type { Track } from "./model.ts";
import type { PortErrors, PortFns, Ports } from "./port.ts";
import { withPhantom, joinTyped, type ErasedFn, type Phantom } from "./erased.ts";
import { and, changed, not, onCreate, or, type IsAlways, type TrackKind, type WhenParam } from "./when.ts";

type RuleTypes<S, Out, E, P, A> = {
  readonly state: S;
  readonly out: Out;
  readonly error: E;
  readonly ports: P;
  readonly always: A;
};

export type Rule<
  K extends TrackKind = TrackKind,
  T extends string = string,
  N extends string = string,
  S = unknown,
  Out = unknown,
  E = unknown,
  P extends Ports = Ports,
  A extends boolean = boolean,
> = {
  readonly kind: "rule";
  readonly track: { readonly kind: K; readonly target: T };
  readonly name: N;
  readonly requires: Ports;
  readonly when: ErasedFn<boolean>;
  readonly check: ErasedFn<AnyResult | Promise<AnyResult>>;
} & Phantom<RuleTypes<S, Out, E, P, A>>;

type AnyResult = Result.Result<unknown, unknown>;
type SuccessOf<R> = Awaited<R> extends infer X ? (X extends Result.Success<infer V> ? V : never) : never;
type FailureOf<R> = Awaited<R> extends infer X ? (X extends Result.Failure<infer E> ? E : never) : never;

export function rule<
  K extends TrackKind,
  T extends string,
  S,
  const N extends string,
  W extends WhenParam<K, S>,
  R extends AnyResult | Promise<AnyResult>,
  P extends Ports = {},
>(
  track: Track<K, T, S>,
  def: {
    readonly name: N;
    readonly requires?: P;
    readonly when: W;
    readonly check: (s: S, ports: PortFns<P>) => R;
  },
): Rule<K, T, N, S, SuccessOf<R>, FailureOf<R> | PortErrors<P>, P, IsAlways<W>> {
  return withPhantom<Rule<K, T, N, S, SuccessOf<R>, FailureOf<R> | PortErrors<P>, P, IsAlways<W>>>(
    Object.freeze({
      kind: "rule",
      track: { kind: track.kind, target: track.target },
      name: def.name,
      requires: Object.freeze({ ...def.requires }),
      when: def.when,
      check: def.check,
    }),
  );
}

const valueOf = (o: object | null, f: string): unknown => (o === null ? undefined : new Map(Object.entries(o)).get(f));

export const immutable = <
  T extends string,
  S extends { readonly pre: object | null; readonly next: object },
  const F extends readonly (keyof S["next"] & string)[],
>(
  track: Track<"save", T, S>,
  fields: F,
) => {
  const isChanged = (s: S, f: string) => !Object.is(valueOf(s.pre, f), valueOf(s.next, f));
  return rule(track, {
    name: `作成後に変えられない項目: ${joinTyped(fields)}` as const,
    when: and(not(onCreate), or(...fields.map((f) => changed(f)))),
    check: (s) => {
      const field = fields.find((f) => isChanged(s, f));
      return field === undefined ? Result.succeed() : Result.fail({ code: "IMMUTABLE_FIELD_CHANGED" as const, field });
    },
  });
};
