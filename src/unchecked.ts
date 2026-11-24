// 型の上では入力と出力の対応が決まっているが、TypeScript が実装に型を付けられない変換をここに集める。
// どの関数も、呼び出し側が変換先の型を選ぶことはできない。変換先は引数の型から決まる。
// 新しく足すときも、任意の型へ変換できる汎用の関数は作らない。
import type { Result } from "@praha/byethrow";
import type { Bound } from "./bind.ts";
import {
  clock,
  type Impl,
  type Impls,
  type Port,
  type PortArgs,
  type PortCall,
  type PortFns,
  type Ports,
  type PortValue,
} from "./port.ts";
import type { CheckResult, FailureOf, Rule, SuccessOf } from "./rule.ts";
import type { AnyRunnable, RuleSet } from "./rules.ts";
import type { Advance, RunnableRuleset } from "./ruleset.ts";
import type { AnySealed, ContentsOf } from "./seal.ts";
import type { AnyWhen, CombinedNeed, TrackKind, WhenParam } from "./when.ts";

// requires の port ごとに、check に渡す関数を作る。object を key ごとの型で組み立てる型を TypeScript は付けられない
export const portFns = <P extends Ports>(
  requires: P | undefined,
  call: <K extends keyof P>(p: P[K], args: PortArgs<P[K]>) => Promise<PortValue<P[K]>>,
): PortFns<P> => {
  if (requires === undefined) return {} as PortFns<P>;
  const keys = Object.keys(requires) as (keyof P & string)[];
  const entries = keys.map((key) => [key, (...args: PortArgs<P[typeof key]>) => call(requires[key], args)] as const);
  return Object.fromEntries(entries) as unknown as PortFns<P>;
};

// provider は provide で port の型に合わせてから、port の token で登録している
export const implFor = <P extends Port>(impls: Impls, p: P): Impl<P> | undefined =>
  impls.get(p.token) as Impl<P> | undefined;

// and と or は、並べた when がそれぞれ受け取る状態をすべて満たす状態で呼ばれる
export const allHold = <Ws extends readonly AnyWhen[]>(ws: Ws, s: CombinedNeed<Ws>): boolean =>
  ws.every((w) => (w as (s: CombinedNeed<Ws>) => boolean)(s));

export const anyHolds = <Ws extends readonly AnyWhen[]>(ws: Ws, s: CombinedNeed<Ws>): boolean =>
  ws.some((w) => (w as (s: CombinedNeed<Ws>) => boolean)(s));

export type Join<F extends readonly string[]> = F extends readonly [
  infer H extends string,
  ...infer Rest extends readonly string[],
]
  ? Rest extends readonly []
    ? H
    : `${H}, ${Join<Rest>}`
  : string;

// 実行時の join と同じ文字列を型の上でも組み立てる。TypeScript は join の結果を string としか型付けない
export const joinTyped = <const F extends readonly string[]>(fields: F): Join<F> => fields.join(", ") as Join<F>;

const objectOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : undefined;

// rule の check の成功の値を状態に重ねる。next は項目ごとに重ねる。
// 重ねた結果の型は Advance で決まる。always の rule は ruleset が必ず当て、
// 当てたときだけ applied を渡すので、Advance の分岐と実行時の値が一致する
export const advanced = <
  K extends TrackKind,
  T extends string,
  N extends string,
  S,
  W extends WhenParam<K, S>,
  R extends CheckResult,
  P extends Ports,
>(
  _rule: Rule<K, T, N, S, W, R, P>,
  s: S,
  applied: { readonly value: SuccessOf<R> } | undefined,
): Advance<S, SuccessOf<R>, W> => {
  const out = applied === undefined ? undefined : objectOf(applied.value);
  const state = objectOf(s);
  if (out === undefined || state === undefined) return s as Advance<S, SuccessOf<R>, W>;
  const before = objectOf(state["next"]);
  const added = objectOf(out["next"]);
  const merged =
    before !== undefined && added !== undefined
      ? { ...state, ...out, next: { ...before, ...added } }
      : { ...state, ...out };
  return merged as Advance<S, SuccessOf<R>, W>;
};

// 封をした値の中身の型は、封をした値の型が持っている。read は封をした値から中身を取り出す
export const contentsOf = <S extends AnySealed>(s: S, read: (value: object) => unknown): ContentsOf<S> =>
  read(s) as ContentsOf<S>;

// bind は model の schema と load から、modelRules が型で確かめた開始の状態を組み立てて線路を走らせる
export const runErased = (r: AnyRunnable): ((s: unknown, call: PortCall) => Promise<Result.Result<unknown, unknown>>) =>
  r.run as (s: unknown, call: PortCall) => Promise<Result.Result<unknown, unknown>>;

// clock の provider は provide の overload で、時刻の数を返す関数に合わせてある
export const clockFor = (impls: Impls): (() => number) | undefined =>
  impls.get(clock.token) as (() => number) | undefined;

// bind は rule の組ごとに、その名前で Bound の型どおりのメソッドを置く
export const boundOf = <Sets extends readonly RuleSet[]>(
  _sets: Sets,
  methods: Readonly<Record<string, object>>,
): Bound<Sets> => methods as Bound<Sets>;

// check の返り値は Result か、Result の Promise。await した値は成功と失敗の型を R から引ける
export const checked = <R extends CheckResult>(r: Awaited<R>): Result.Result<SuccessOf<R>, FailureOf<R>> =>
  r as Result.Result<SuccessOf<R>, FailureOf<R>>;

// 線路は受け取った状態に値を重ねるだけなので、先頭の rule の前提より多くを持つ状態で始めれば、最後の状態もそれを持つ
export const runFrom = async <Start extends In, In, S, E, PN extends string>(
  r: RunnableRuleset<In, S, E, PN>,
  start: Start,
  call: PortCall,
): Promise<Result.Result<Start & S, E>> => (await r.run(start, call)) as Result.Result<Start & S, E>;
