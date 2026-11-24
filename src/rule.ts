import { Result } from "@praha/byethrow";
import type { Track } from "./model.ts";
import type { NoPorts, PortFns, Ports } from "./port.ts";
import {
  always,
  changed,
  describeWhen,
  onCreate,
  whenOf,
  type Always,
  type TrackKind,
  type WhenParam,
} from "./when.ts";

export type Checked<V, E> = Result.Result<V, E> | Promise<Result.Result<V, E>>;
export type CheckResult = Checked<unknown, unknown>;
type SuccessOf<R> = Awaited<R> extends infer X ? (X extends Result.Success<infer V> ? V : never) : never;
type FailureOf<R> = Awaited<R> extends infer X ? (X extends Result.Failure<infer E> ? E : never) : never;

// rule は線路の1つの step。check の型がそのまま、受け取る状態・成功の値・失敗の型を表す
export type Rule<
  K extends TrackKind,
  T extends string,
  N extends string,
  S,
  W extends WhenParam<K, S>,
  V,
  E,
  P extends Ports,
> = {
  readonly kind: "rule";
  // 線路の種類は型の上で rule と線路を合わせるためにある。どの線路にも置ける rule は持たない
  readonly track?: { readonly kind: K; readonly target: T };
  readonly name: N;
  readonly requires: P | undefined;
  readonly when: W;
  readonly check: (s: S, ports: PortFns<P>) => Checked<V, E>;
};

export function rule<
  K extends TrackKind,
  T extends string,
  S,
  const N extends string,
  W extends WhenParam<K, S>,
  R extends CheckResult,
  P extends Ports = NoPorts,
  // 成功の値と失敗の型は check の返り値から引く。返り値の型を、引いた型の Result として扱えることは呼び出す側で確かめる
  V = SuccessOf<R>,
  E = FailureOf<R>,
>(
  track: Track<K, T, S>,
  def: {
    readonly name: N;
    readonly requires?: P;
    readonly when: W;
    readonly check: (s: S, ports: PortFns<P>) => R & NoInfer<Checked<V, E>>;
  },
): Rule<K, T, N, S, W, V, E, P> {
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

export const immutable = <T extends string, S extends { readonly pre: object | null; readonly next: object }>(
  track: Track<"save", T, S>,
  fields: readonly (keyof S["next"] & string)[],
) => {
  const changedField = (s: S) => fields.find((f) => !Object.is(valueOf(s.pre, f), valueOf(s.next, f)));
  return rule(track, {
    name: `作成後に変えられない項目: ${fields.join(", ")}` as const,
    // 説明は and(not(onCreate), or(changed(...))) と同じ形にする。判定は項目の数によらず1つの関数で書く
    when: whenOf<"save", S>(
      {
        kind: "and",
        conditions: [
          { kind: "not", condition: describeWhen(onCreate) },
          { kind: "or", conditions: fields.map((f) => describeWhen(changed(f))) },
        ],
      },
      (s) => s.pre !== null && changedField(s) !== undefined,
    ),
    check: (s) => {
      const field = changedField(s);
      return field === undefined ? Result.succeed() : Result.fail({ code: "IMMUTABLE_FIELD_CHANGED" as const, field });
    },
  });
};

// 何も確かめずに通す rule。条件なしで削除してよい model の delete に ruleset(alwaysAllow) として渡す
export const alwaysAllow: Rule<TrackKind, string, "常に許可", unknown, Always, void, never, NoPorts> = Object.freeze({
  kind: "rule",
  name: "常に許可",
  requires: undefined,
  when: always,
  check: () => Result.succeed(),
});
