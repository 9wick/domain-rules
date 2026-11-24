// 型の上では入力と出力の対応が決まっているが、TypeScript が実装に型を付けられない変換をここに集める。
// どの関数も、呼び出し側が変換先の型を選ぶことはできない。変換先は引数の型から決まる。
// 新しく足すときも、任意の型へ変換できる汎用の関数は作らない。
import type { Result } from "@praha/byethrow";
import type { Bound } from "./bind.ts";
import {
  type Impl,
  type Impls,
  type Port,
  type PortArgs,
  type PortCall,
  type PortFns,
  type Ports,
  type PortValue,
} from "./port.ts";
import type { AnyDecider, AnyRunnable, RuleSet } from "./rules.ts";

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

// bind は model の schema と load から、modelRules が型で確かめた開始の状態を組み立てて線路を走らせる
export const runErased = (
  r: AnyRunnable | AnyDecider,
): ((s: unknown, call: PortCall) => Promise<Result.Result<unknown, unknown>>) =>
  r.run as (s: unknown, call: PortCall) => Promise<Result.Result<unknown, unknown>>;

// bind は rule の組ごとに、その名前で Bound の型どおりのメソッドを置く
export const boundOf = <Sets extends readonly RuleSet[]>(
  _sets: Sets,
  methods: Readonly<Record<string, object>>,
): Bound<Sets> => methods as Bound<Sets>;
