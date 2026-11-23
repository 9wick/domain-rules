import { Result } from "@praha/byethrow";
import type { Track } from "./model.ts";
import type { PortErrors, PortFns, Ports } from "./port.ts";
import { and, changed, not, onCreate, or, type IsAlways, type TrackKind, type WhenParam } from "./when.ts";

declare const ruleTypes: unique symbol;

export type Rule<
  K extends TrackKind = any,
  T extends string = any,
  N extends string = any,
  S = any,
  Out = any,
  E = any,
  P extends Ports = any,
  A extends boolean = boolean,
> = {
  readonly kind: "rule";
  readonly track: { readonly kind: K; readonly target: T };
  readonly name: N;
  readonly requires: P;
  readonly when: (s: any) => boolean;
  readonly check: (s: any, ports: any) => unknown;
  readonly [ruleTypes]: { readonly state: S; readonly out: Out; readonly error: E; readonly always: A };
};

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
  return Object.freeze({
    kind: "rule",
    track: { kind: track.kind, target: track.target },
    name: def.name,
    requires: Object.freeze({ ...def.requires }),
    when: def.when,
    check: def.check,
  }) as unknown as Rule<K, T, N, S, SuccessOf<R>, FailureOf<R> | PortErrors<P>, P, IsAlways<W>>;
}

type Join<F extends readonly string[]> = F extends readonly [infer H extends string, ...infer Rest extends readonly string[]]
  ? Rest extends readonly [] ? H : `${H}, ${Join<Rest>}`
  : string;

export const immutable = <
  T extends string,
  S extends { readonly pre: object | null; readonly next: object },
  const F extends readonly (keyof S["next"] & string)[],
>(
  track: Track<"save", T, S>,
  fields: F,
) => {
  const isChanged = (s: S, f: string) =>
    !Object.is((s.pre as Record<string, unknown>)[f], (s.next as Record<string, unknown>)[f]);
  return rule(track, {
    name: `作成後に変えられない項目: ${fields.join(", ")}` as `作成後に変えられない項目: ${Join<F>}`,
    when: and(not(onCreate), or(...fields.map((f) => changed(f)))) as WhenParam<"save", S>,
    check: (s) => {
      const field = fields.find((f) => isChanged(s, f));
      return field === undefined
        ? Result.succeed()
        : Result.fail({ code: "IMMUTABLE_FIELD_CHANGED" as const, field: field as F[number] });
    },
  });
};
