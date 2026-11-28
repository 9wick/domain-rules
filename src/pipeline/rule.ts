import * as Result from "../shared/result.ts";
import { getOrEmpty, type OmittableIfEmpty } from "as-free";
import type { Track, TrackKind } from "../definition/track.ts";
import type { Invocation } from "../port/invocation.ts";
import type { AnyPort, NoPorts } from "../port/port.ts";
import { withPorts, type CheckTools, type PortFns, type Requires, type StrictRecord } from "./requires.ts";
import { conditionalStep, type ConditionalStep } from "./when/step.ts";
import type { WhenParam } from "./when/when.ts";

export type Checked<V, E> = Result.Result<V, E> | Promise<Result.Result<V, E>>;
export type CheckResult = Checked<unknown, unknown>;
export type SuccessOf<R> = Awaited<R> extends infer X ? (X extends Result.Success<infer V> ? V : never) : never;
export type FailureOf<R> = Awaited<R> extends infer X ? (X extends Result.Failure<infer E> ? E : never) : never;

declare const rulePorts: unique symbol;
declare const ruleTrack: unique symbol;

// rule は線路の1つの step。run の型がそのまま、受け取る状態・成功の値・失敗の型を表す。
// I は失敗を判別する識別子。説明文を直しても呼び出し側の分岐が壊れないよう、description とは分けて持つ。
// P は requires に書いた port の record の型で、bind が provider の不足を型で確かめるために持つ。
// Ev は emit が発行するイベントの型。emit で作った rule だけが event を持つ
export type Rule<
  K extends TrackKind,
  T extends string,
  I extends string,
  S,
  W extends WhenParam<K, S>,
  V,
  E,
  P,
  Ev = never,
> = {
  readonly kind: "rule";
  // 型の上で rule と線路を合わせるための印。実行時には持たない。どの線路にも置ける alwaysAllow は印を持たない
  readonly [ruleTrack]?: { readonly kind: K; readonly target: T };
  readonly [rulePorts]?: P;
  readonly id: I;
  readonly description: string;
  readonly ports: readonly AnyPort[];
  // when に、状態をどう進めるかの step を付けたもの。always のように自分の step を持つ when は、その step が残る
  readonly when: W & { readonly step: ConditionalStep<S> };
  readonly run: (s: S, invocation: Invocation) => Promise<Result.Result<V, E>>;
  // when が当たったときに線路が呼び、返した値をイベントとして溜める
  readonly event?: (s: S) => Ev;
};

export function rule<
  K extends TrackKind,
  T extends string,
  S,
  const I extends string,
  W extends WhenParam<K, S>,
  R extends CheckResult,
  P extends Requires = NoPorts,
  // 成功の値と失敗の型は check の返り値から引く。返り値の型を、引いた型の Result として扱えることは呼び出す側で確かめる
  V = SuccessOf<R>,
  E = FailureOf<R>,
>(
  // 線路は型を決めるためだけに受け取る
  _track: Track<K, T, S>,
  // requires を省略できるのは、check が受け取る port がないときだけ
  def: {
    readonly id: I;
    readonly description: string;
    readonly requires?: P & StrictRecord<P>;
    readonly when: W;
    readonly check: (s: S, ports: PortFns<P>, tools: CheckTools<P>) => R & NoInfer<Checked<V, E>>;
  } & OmittableIfEmpty<"requires", P & StrictRecord<P>>,
): Rule<K, T, I, S, W, V, E, NoInfer<P>> {
  const requires: P = getOrEmpty<"requires", P & StrictRecord<P>>(def, "requires");
  const check: (s: S, ports: PortFns<P>, tools: CheckTools<P>) => Checked<V, E> = def.check;
  const step = withPorts(requires, check);
  const run = async (s: S, invocation: Invocation): Promise<Result.Result<V, E>> => step(s, invocation);
  return Object.freeze({
    kind: "rule",
    id: def.id,
    description: def.description,
    ports: Object.values(requires),
    when: Object.freeze(Object.assign((s: S) => def.when(s), { step: conditionalStep(def.when) }, def.when)),
    run,
  });
}
