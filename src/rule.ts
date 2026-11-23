import { Result } from "@praha/byethrow";
import type { Track } from "./model.ts";
import type { NoPorts, PortFns, Ports } from "./port.ts";
import { joinTyped } from "./unchecked.ts";
import { and, changed, not, onCreate, or, type TrackKind, type WhenParam } from "./when.ts";

export type CheckResult = Result.Result<unknown, unknown> | Promise<Result.Result<unknown, unknown>>;
export type SuccessOf<R> = Awaited<R> extends infer X ? (X extends Result.Success<infer V> ? V : never) : never;
export type FailureOf<R> = Awaited<R> extends infer X ? (X extends Result.Failure<infer E> ? E : never) : never;

// rule は線路の1つの step。check の型がそのまま、受け取る状態・成功の値・失敗の型を表す
export type Rule<
  K extends TrackKind,
  T extends string,
  N extends string,
  S,
  W extends WhenParam<K, S>,
  R extends CheckResult,
  P extends Ports,
> = {
  readonly kind: "rule";
  readonly track: { readonly kind: K; readonly target: T };
  readonly name: N;
  readonly requires: P | undefined;
  readonly when: W;
  readonly check: (s: S, ports: PortFns<P>) => R;
};

export function rule<
  K extends TrackKind,
  T extends string,
  S,
  const N extends string,
  W extends WhenParam<K, S>,
  R extends CheckResult,
  P extends Ports = NoPorts,
>(
  track: Track<K, T, S>,
  def: {
    readonly name: N;
    readonly requires?: P;
    readonly when: W;
    readonly check: (s: S, ports: PortFns<P>) => R;
  },
): Rule<K, T, N, S, W, R, P> {
  return Object.freeze({
    kind: "rule",
    track: { kind: track.kind, target: track.target },
    name: def.name,
    requires: def.requires,
    when: def.when,
    check: def.check,
  });
}

const valueOf = (o: object | null, f: string): unknown => (o === null ? undefined : new Map(Object.entries(o)).get(f));

export const immutable = <
  T extends string,
  S extends { readonly pre: object | null; readonly next: object },
  const F extends readonly (keyof S["next"] & string)[],
>(
  track: Track<"save", T, S>,
  fields: F,
) =>
  rule(track, {
    name: `作成後に変えられない項目: ${joinTyped(fields)}` as const,
    when: and(not(onCreate), or(...fields.map((f) => changed(f)))),
    check: (s) => {
      const field = fields.find((f) => !Object.is(valueOf(s.pre, f), valueOf(s.next, f)));
      return field === undefined ? Result.succeed() : Result.fail({ code: "IMMUTABLE_FIELD_CHANGED" as const, field });
    },
  });
