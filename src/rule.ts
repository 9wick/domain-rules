import { Result } from "@praha/byethrow";
import { getOrEmpty, type OmittableIfEmpty } from "as-free";
import type { Track } from "./model.ts";
import {
  type AnyPort,
  type Invocation,
  type NoPorts,
  type PortFns,
  type Requires,
  type StrictRecord,
  resolvePorts,
} from "./port.ts";
import {
  always,
  changed,
  conditionalStep,
  describeWhen,
  onCreate,
  whenOf,
  type Always,
  type ConditionalStep,
  type TrackKind,
  type WhenParam,
} from "./when.ts";

export type Checked<V, E> = Result.Result<V, E> | Promise<Result.Result<V, E>>;
export type CheckResult = Checked<unknown, unknown>;
type SuccessOf<R> = Awaited<R> extends infer X ? (X extends Result.Success<infer V> ? V : never) : never;
type FailureOf<R> = Awaited<R> extends infer X ? (X extends Result.Failure<infer E> ? E : never) : never;

declare const rulePorts: unique symbol;

// rule は線路の1つの step。run の型がそのまま、受け取る状態・成功の値・失敗の型を表す。
// P は requires に書いた port の record の型で、bind が provider の不足を型で確かめるために持つ
export type Rule<K extends TrackKind, T extends string, N extends string, S, W extends WhenParam<K, S>, V, E, P> = {
  readonly kind: "rule";
  // 線路の種類は型の上で rule と線路を合わせるためにある。どの線路にも置ける rule は持たない
  readonly track?: { readonly kind: K; readonly target: T };
  readonly [rulePorts]?: P;
  readonly name: N;
  readonly ports: readonly AnyPort[];
  // when に、状態をどう進めるかの step を付けたもの。always のように自分の step を持つ when は、その step が残る
  readonly when: W & { readonly step: ConditionalStep<S> };
  readonly run: (s: S, invocation: Invocation) => Promise<Result.Result<V, E>>;
};

export function rule<
  K extends TrackKind,
  T extends string,
  S,
  const N extends string,
  W extends WhenParam<K, S>,
  R extends CheckResult,
  P extends Requires = NoPorts,
  // 成功の値と失敗の型は check の返り値から引く。返り値の型を、引いた型の Result として扱えることは呼び出す側で確かめる
  V = SuccessOf<R>,
  E = FailureOf<R>,
>(
  track: Track<K, T, S>,
  // requires を省略できるのは、check が受け取る port がないときだけ
  def: {
    readonly name: N;
    readonly requires?: P & StrictRecord<P>;
    readonly when: W;
    readonly check: (s: S, ports: PortFns<P>) => R & NoInfer<Checked<V, E>>;
  } & OmittableIfEmpty<"requires", P & StrictRecord<P>>,
): Rule<K, T, N, S, W, V, E, NoInfer<P>> {
  const requires: P = getOrEmpty<"requires", P & StrictRecord<P>>(def, "requires");
  const check: (s: S, ports: PortFns<P>) => Checked<V, E> = def.check;
  const run = async (s: S, invocation: Invocation): Promise<Result.Result<V, E>> =>
    check(s, resolvePorts(requires, invocation));
  return Object.freeze({
    kind: "rule",
    track: { kind: track.kind, target: track.target },
    name: def.name,
    ports: Object.values(requires),
    when: Object.freeze(Object.assign((s: S) => def.when(s), { step: conditionalStep(def.when) }, def.when)),
    run,
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
  ports: [],
  when: always,
  run: async () => Result.succeed(),
});
