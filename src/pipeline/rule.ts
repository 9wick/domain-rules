import * as Result from "../shared/result.ts";
import { getOrEmpty, type OmittableIfEmpty } from "as-free";
import type { Track, TrackKind } from "../definition/track.ts";
import type { Invocation } from "../port/invocation.ts";
import type { AnyPort, NoPorts } from "../port/port.ts";
import {
  resolvePorts,
  unwrapPorts,
  type PortFns,
  type Requires,
  type StrictRecord,
  type UnwrappedPortFns,
} from "./requires.ts";
import { safeTryWith, type SafeTry } from "./safe-try.ts";
import { conditionalStep, type ConditionalStep } from "./when/step.ts";
import type { WhenParam } from "./when/when.ts";

export type Checked<V, E> = Result.Result<V, E> | Promise<Result.Result<V, E>>;
export type CheckResult = Checked<unknown, unknown>;
export type SuccessOf<R> = Awaited<R> extends infer X ? (X extends Result.Success<infer V> ? V : never) : never;
export type FailureOf<R> = Awaited<R> extends infer X ? (X extends Result.Failure<infer E> ? E : never) : never;

// check の第3引数。port の Result を if で取り出す代わりに、yield* で取り出して書くための道具
export type CheckTools<P extends Requires> = { readonly safeTry: SafeTry<UnwrappedPortFns<P>> };

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
    readonly check: (s: S, ports: PortFns<P>, tools: CheckTools<P>) => R & NoInfer<Checked<V, E>>;
  } & OmittableIfEmpty<"requires", P & StrictRecord<P>>,
): Rule<K, T, N, S, W, V, E, NoInfer<P>> {
  const requires: P = getOrEmpty<"requires", P & StrictRecord<P>>(def, "requires");
  const check: (s: S, ports: PortFns<P>, tools: CheckTools<P>) => Checked<V, E> = def.check;
  const run = async (s: S, invocation: Invocation): Promise<Result.Result<V, E>> =>
    check(s, resolvePorts(requires, invocation), { safeTry: safeTryWith(unwrapPorts(requires, invocation)) });
  return Object.freeze({
    kind: "rule",
    track: { kind: track.kind, target: track.target },
    name: def.name,
    ports: Object.values(requires),
    when: Object.freeze(Object.assign((s: S) => def.when(s), { step: conditionalStep(def.when) }, def.when)),
    run,
  });
}
