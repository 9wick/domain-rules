import { Result } from "@praha/byethrow";
import type { AnyPort, Invocation, PortErrors, PortNames, Ports } from "./port.ts";
import type { Rule } from "./rule.ts";
import {
  describeWhen,
  type Check,
  type IsAlways,
  type TrackKind,
  type WhenDescription,
  type WhenParam,
} from "./when.ts";

// rule が状態に重ねる型。何も返さない check は状態を変えない。当たらないこともある rule では、重ねない場合も残る
type Lift<V> = [V] extends [object] ? V : unknown;
export type Delta<V, W> = IsAlways<W> extends true ? Lift<V> : {} | Lift<V>;

type NextOf<S> = S extends { readonly next: infer X } ? X : never;
type Narrowing<S, O> = {
  readonly [K in keyof O]: K extends "next"
    ? { readonly [F in keyof O[K]]: F extends keyof NextOf<S> ? NextOf<S>[F] : unknown }
    : K extends keyof S
      ? S[K]
      : unknown;
};
// 状態の項目は、より狭い型にだけ変えられる。別の型に置き換えると、重ねた状態の型と実際の値がずれる
type NarrowGuard<S, O> = [O] extends [object]
  ? O extends Narrowing<S, O>
    ? unknown
    : { readonly 状態の項目を別の型に置き換えている: O }
  : unknown;

export type StepFailure<N, E> = { readonly step: N; readonly error: E };

export type PlannedRule = { readonly name: string; readonly when: WhenDescription; readonly ports: readonly string[] };

declare const portNames: unique symbol;
declare const rulesetTypes: unique symbol;
declare const startState: unique symbol;

// when が状態をどう進めるか。線路は、rule の when が持つ step がこの型を満たすことを add で確かめる
type Stepper<Cur, V, E, D> = <X extends Cur>(s: X, check: Check<X, V, E>) => Promise<Result.Result<X & D, E>>;

type RunState<In, D, E> = <X extends In>(s: X, invocation: Invocation) => Promise<Result.Result<X & D, E>>;

// rule を先頭から順に当てる線路。rule を足すたびに、前の rule が作った状態の型を次の rule が受け取れるかを型で確かめる。
// 状態は、開始の状態に rule が重ねた型 D を足したもの。開始の状態の型は走らせる側が決め、そのまま最後まで残る
export class Ruleset<K extends TrackKind, T extends string, In extends {}, D, E, PN extends string> {
  declare readonly [portNames]: PN;
  declare readonly [rulesetTypes]: { readonly delta: D; readonly error: E };
  // 開始の状態の型。走らせる側の開始の状態がこの型に代入できるかを、引数の型として確かめる
  declare readonly [startState]: (s: In) => void;
  readonly kind = "ruleset";
  readonly plan: readonly PlannedRule[];
  readonly ports: readonly AnyPort[];
  readonly run: RunState<In, D, E>;

  constructor(plan: readonly PlannedRule[], ports: readonly AnyPort[], run: RunState<In, D, E>) {
    this.plan = plan;
    this.ports = ports;
    this.run = run;
    Object.freeze(this);
  }

  add<N extends string, W extends WhenParam<K, In & D>, V, E2, P extends Ports>(
    r: Rule<K, T, N, In & D, W, V, E2, P> &
      NarrowGuard<In & D, V> & {
        readonly when: { readonly step: Stepper<In & D, V, StepFailure<N, E2 | PortErrors<P>>, Delta<V, W>> };
      },
  ): Ruleset<K, T, In, D & Delta<V, W>, E | StepFailure<N, E2 | PortErrors<P>>, PN | PortNames<P>> {
    const previous = this.run;
    const ports = r.ports;
    // r.when.step は、rule が付けた step と when 自身の step の交差型になる。add で確かめた型の方で呼ぶ
    const step: Stepper<In & D, V, StepFailure<N, E2 | PortErrors<P>>, Delta<V, W>> = r.when.step;
    return new Ruleset<K, T, In, D & Delta<V, W>, E | StepFailure<N, E2 | PortErrors<P>>, PN | PortNames<P>>(
      [...this.plan, { name: r.name, when: describeWhen(r.when), ports: ports.map((p) => p.name) }],
      [...this.ports, ...ports],
      async <X extends In>(s0: X, invocation: Invocation) => {
        const prev = await previous(s0, invocation);
        if (Result.isFailure(prev)) return prev;
        return step(prev.value, async (s) => {
          const out = await r.run(s, invocation);
          return Result.isFailure(out) ? Result.fail({ step: r.name, error: out.error }) : out;
        });
      },
    );
  }
}

const start = <
  K extends TrackKind,
  T extends string,
  S,
  N extends string,
  W extends WhenParam<K, S & {}>,
  V,
  E2,
  P extends Ports,
>(
  first: Rule<K, T, N, S & {}, W, V, E2, P> &
    NarrowGuard<S & {}, V> & {
      readonly when: { readonly step: Stepper<S & {}, V, StepFailure<N, E2 | PortErrors<P>>, Delta<V, W>> };
    },
) =>
  new Ruleset<K, T, S & {}, unknown, never, never>([], [], async (s) => Result.succeed(s)).add<N, W, V, E2, P>(first);

// 先頭の rule が受け取る状態から線路を始める
export const ruleset = start;

// 線路を走らせるのに要る部分。rule を足す add を含めないので、開始の状態の型だけで代入できるかが決まる
export type RunnableRuleset<In extends {}, D, E, PN extends string> = {
  readonly [portNames]: PN;
  readonly [startState]: (s: In) => void;
  readonly [rulesetTypes]: { readonly delta: D; readonly error: E };
  readonly plan: readonly PlannedRule[];
  readonly ports: readonly AnyPort[];
  readonly run: RunState<In, D, E>;
};
export type RulesetOut<R> = R extends { readonly [rulesetTypes]: { readonly delta: infer D } } ? D : never;
export type RulesetError<R> = R extends { readonly [rulesetTypes]: { readonly error: infer E } } ? E : never;
export type RulesetPorts<R> = R extends { readonly [portNames]: infer PN } ? PN : never;

// action の線路。最後の状態から output で返す値を組み立てるので、開始の状態から返す値までを1つの関数で表す
export type Decider<In, Out, E, PN extends string> = {
  readonly [portNames]: PN;
  readonly plan: readonly PlannedRule[];
  readonly ports: readonly AnyPort[];
  readonly run: (s: In, invocation: Invocation) => Promise<Result.Result<Out, E>>;
};
