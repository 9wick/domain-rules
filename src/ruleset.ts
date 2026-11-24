import { Result } from "@praha/byethrow";
import { runWithPorts, type Port, type PortCall, type PortErrors, type PortNames, type Ports } from "./port.ts";
import type { CheckResult, FailureOf, Rule, SuccessOf } from "./rule.ts";
import { advanced, checked } from "./unchecked.ts";
import { describeWhen, isAlways, type IsAlways, type TrackKind, type WhenDescription, type WhenParam } from "./when.ts";

// 当たれば成功の値を状態に重ね、当たらないこともある rule では重ねる前の状態も残る
export type Advance<S, O, W> = [O] extends [object] ? (IsAlways<W> extends true ? S & O : S | (S & O)) : S;

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

// rule を先頭から順に当てる線路。rule を足すたびに、前の rule が作った状態の型を次の rule が受け取れるかを型で確かめる
export class Ruleset<K extends TrackKind, T extends string, In, S, E, PN extends string> {
  declare readonly [portNames]: PN;
  readonly kind = "ruleset";
  readonly plan: readonly PlannedRule[];
  readonly ports: readonly Port[];
  readonly run: (s: In, call: PortCall) => Promise<Result.Result<S, E>>;

  constructor(
    plan: readonly PlannedRule[],
    ports: readonly Port[],
    run: (s: In, call: PortCall) => Promise<Result.Result<S, E>>,
  ) {
    this.plan = plan;
    this.ports = ports;
    this.run = run;
    Object.freeze(this);
  }

  add<N extends string, W extends WhenParam<K, S>, R extends CheckResult, P extends Ports>(
    r: Rule<K, T, N, S, W, R, P> & NarrowGuard<S, SuccessOf<R>>,
  ): Ruleset<
    K,
    T,
    In,
    Advance<S, SuccessOf<R>, W>,
    E | StepFailure<N, FailureOf<R> | PortErrors<P>>,
    PN | PortNames<P>
  > {
    const previous = this.run;
    const ports = Object.values(r.requires ?? {});
    return new Ruleset<
      K,
      T,
      In,
      Advance<S, SuccessOf<R>, W>,
      E | StepFailure<N, FailureOf<R> | PortErrors<P>>,
      PN | PortNames<P>
    >(
      [...this.plan, { name: r.name, when: describeWhen(r.when), ports: ports.map((p) => p.name) }],
      [...this.ports, ...ports],
      async (s0, call) => {
        const prev = await previous(s0, call);
        return Result.isFailure(prev) ? prev : step(r, prev.value, call);
      },
    );
  }
}

const step = async <
  K extends TrackKind,
  T extends string,
  N extends string,
  S,
  W extends WhenParam<K, S>,
  R extends CheckResult,
  P extends Ports,
>(
  r: Rule<K, T, N, S, W, R, P>,
  s: S,
  call: PortCall,
): Promise<Result.Result<Advance<S, SuccessOf<R>, W>, StepFailure<N, FailureOf<R> | PortErrors<P>>>> => {
  if (!isAlways(r.when) && !r.when(s)) return Result.succeed(advanced(r, s, undefined));
  const out = await runWithPorts(call, r.requires, async (fns) => checked<R>(await r.check(s, fns)));
  return Result.isFailure(out)
    ? Result.fail({ step: r.name, error: out.error })
    : Result.succeed(advanced(r, s, { value: out.value }));
};

const start = <
  K extends TrackKind,
  T extends string,
  S,
  N extends string,
  W extends WhenParam<K, S>,
  R extends CheckResult,
  P extends Ports,
>(
  first: Rule<K, T, N, S, W, R, P> & NarrowGuard<S, SuccessOf<R>>,
) => new Ruleset<K, T, S, S, never, never>([], [], async (s) => Result.succeed(s)).add<N, W, R, P>(first);

// 先頭の rule が受け取る状態から線路を始める
export const ruleset = start;

// 線路を走らせるのに要る部分。rule を足す add を含めないので、開始の状態の型だけで代入できるかが決まる
export type RunnableRuleset<In, S, E, PN extends string> = {
  readonly [portNames]: PN;
  readonly plan: readonly PlannedRule[];
  readonly ports: readonly Port[];
  readonly run: (s: In, call: PortCall) => Promise<Result.Result<S, E>>;
};
export type RulesetOut<R> = R extends RunnableRuleset<never, infer S, unknown, string> ? S : never;
export type RulesetPorts<R> = R extends { readonly [portNames]: infer PN } ? PN : never;
