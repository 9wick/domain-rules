import * as Result from "../shared/result.ts";
import type { TrackKind } from "../definition/track.ts";
import type { Invocation } from "../port/invocation.ts";
import type { AnyPort, PortNames, Ports } from "../port/port.ts";
import type { Rule } from "./rule.ts";
import { describeWhen, type Check, type IsAlways, type WhenDescription, type WhenParam } from "./when/when.ts";

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
// 状態の項目は、より狭い型にだけ変えられる。別の型に置き換えると、重ねた状態の型と実際の値がずれる。
// input は呼び出し時の意思なので変えさせない。Partial なので、狭めたつもりの値で項目が消えても型では気づけない
type NarrowGuard<S, O> = [O] extends [object]
  ? "input" extends keyof O
    ? { readonly 呼び出し時の入力は変えられない: O }
    : O extends Narrowing<S, O>
      ? unknown
      : { readonly 状態の項目を別の型に置き換えている: O }
  : unknown;

export type StepFailure<I, E> = { readonly step: I; readonly error: E };

export type PlannedRule = {
  readonly id: string;
  readonly description: string;
  readonly when: WhenDescription;
  readonly ports: readonly string[];
};

// 線路に並べた rule。plan と ports はこれだけから作り、別々に積み上げない
type Step = {
  readonly id: string;
  readonly description: string;
  readonly when: WhenDescription;
  readonly ports: readonly AnyPort[];
};

// 使う port の名前を型の上で持つ印。bind に渡す rule の組も同じ印で持ち、bind は kind を見ずに port を引く
export declare const portNames: unique symbol;
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

  readonly #steps: readonly Step[];

  constructor(steps: readonly Step[], run: RunState<In, D, E>) {
    this.#steps = steps;
    this.plan = steps.map((s) => ({
      id: s.id,
      description: s.description,
      when: s.when,
      ports: s.ports.map((p) => p.name),
    }));
    this.ports = steps.flatMap((s) => s.ports);
    this.run = run;
    Object.freeze(this);
  }

  add<I extends string, W extends WhenParam<K, In & D>, V, E2, P extends Ports>(
    r: Rule<K, T, I, In & D, W, V, E2, P> &
      NarrowGuard<In & D, V> & {
        readonly when: { readonly step: Stepper<In & D, V, StepFailure<I, E2>, Delta<V, W>> };
      },
  ): Ruleset<K, T, In, D & Delta<V, W>, E | StepFailure<I, E2>, PN | PortNames<P>> {
    const previous = this.run;
    // r.when.step は、rule が付けた step と when 自身の step の交差型になる。add で確かめた型の方で呼ぶ
    const step: Stepper<In & D, V, StepFailure<I, E2>, Delta<V, W>> = r.when.step;
    return new Ruleset<K, T, In, D & Delta<V, W>, E | StepFailure<I, E2>, PN | PortNames<P>>(
      [...this.#steps, { id: r.id, description: r.description, when: describeWhen(r.when), ports: r.ports }],
      async <X extends In>(s0: X, invocation: Invocation) => {
        const prev = await previous(s0, invocation);
        if (prev.type === "Failure") return prev;
        return step(prev.value, async (s) => {
          const out = await r.run(s, invocation);
          return out.type === "Failure" ? Result.fail({ step: r.id, error: out.error }) : out;
        });
      },
    );
  }
}

const start = <
  K extends TrackKind,
  T extends string,
  S,
  I extends string,
  W extends WhenParam<K, S & {}>,
  V,
  E2,
  P extends Ports,
>(
  first: Rule<K, T, I, S & {}, W, V, E2, P> &
    NarrowGuard<S & {}, V> & {
      readonly when: { readonly step: Stepper<S & {}, V, StepFailure<I, E2>, Delta<V, W>> };
    },
) => new Ruleset<K, T, S & {}, unknown, never, never>([], async (s) => Result.succeed(s)).add<I, W, V, E2, P>(first);

// 先頭の rule が受け取る状態から線路を始める
export const ruleset = start;

// 線路を走らせるのに要る部分。rule を足す add を含めないので、開始の状態の型だけで代入できるかが決まる
export type RunnableRuleset<In extends {}, D, E, PN extends string> = Omit<
  Ruleset<TrackKind, string, In, D, E, PN>,
  "add" | "kind"
>;
export type RulesetOut<R> = R extends { readonly [rulesetTypes]: { readonly delta: infer D } } ? D : never;
export type RulesetError<R> = R extends { readonly [rulesetTypes]: { readonly error: infer E } } ? E : never;
export type RulesetPorts<R> = R extends { readonly [portNames]: infer PN } ? PN : never;
