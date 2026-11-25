import { Result } from "@praha/byethrow";
import { Panic } from "../shared/panic.ts";
import type { Invocation } from "./invocation.ts";
import { Provider, register } from "./provider.ts";

declare const portTypes: unique symbol;

type ImplOf<A extends readonly unknown[], T, E> = (...args: A) => Result.Result<T, E> | Result.ResultAsync<T, E>;

// port の実装の置き場。cached で作った port も同じ置き場を使うので、元の宣言の provider で満たせる
class Slots<A extends readonly unknown[], T, E> {
  readonly impls = new WeakMap<object, ImplOf<A, T, E>>();
  readonly memos = new WeakMap<Invocation, Map<string, Promise<Result.Result<T, E>>>>();
}

// port は宣言で、実装は provider であとから渡す。実装は port 自身が、自分の型のまま scope ごとに持つ。
// 型引数は不変にする。広い型の port として扱えると、宣言と違う型の実装を登録できてしまうため
export class Port<N extends string, in out A extends readonly unknown[], in out T, in out E> {
  declare readonly [portTypes]: { readonly args: A; readonly value: T; readonly error: E };
  readonly kind = "port";
  readonly name: N;
  readonly cached: boolean;
  readonly #slots: Slots<A, T, E>;

  constructor(name: N, cached: boolean, slots: Slots<A, T, E>) {
    this.name = name;
    this.cached = cached;
    this.#slots = slots;
    Object.freeze(this);
  }

  // method ではなく関数の property にするのは、method の引数は広い型の object の型へ代入するときに
  // 確かめられず、宣言と違う型の実装を渡せてしまうため
  readonly provider = (impl: ImplOf<A, T, E>): Provider<N> =>
    new Provider(this.name, (scope) => register(this.#slots.impls, scope, impl, this.name));

  readonly valued = (v: T): Provider<N> => this.provider(() => Result.succeed(v));

  readonly providedIn = (scope: object): boolean => this.#slots.impls.has(scope);

  readonly withCache = (): Port<N, A, T, E> => new Port(this.name, true, this.#slots);

  readonly callIn = async (invocation: Invocation, args: A): Promise<Result.Result<T, E>> => {
    const impl = this.#slots.impls.get(invocation.scope);
    // bind が provider の不足を確かめてから呼ぶので、ここに来るのは壊れたときだけ
    if (impl === undefined) throw new Panic(`port "${this.name}" の provider がありません`);
    if (!this.cached) return impl(...args);
    // 同じ引数の呼び出しを1回の呼び出しの中で使い回す
    const memo = this.#slots.memos.get(invocation) ?? new Map<string, Promise<Result.Result<T, E>>>();
    this.#slots.memos.set(invocation, memo);
    const key = JSON.stringify(args);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const pending = Promise.resolve(impl(...args));
    memo.set(key, pending);
    return pending;
  };

  // check に渡す関数。provider と同じ Result を返し、失敗をどう扱うかは check が決める
  readonly resolveIn =
    (invocation: Invocation) =>
    (...args: A): Promise<Result.Result<T, E>> =>
      this.callIn(invocation, args);
}

// 型引数を問わない port。型の上で port の一覧を持つためで、実装の登録や呼び出しには使えない
export type AnyPort = {
  readonly kind: "port";
  readonly name: string;
  readonly cached: boolean;
  readonly providedIn: (scope: object) => boolean;
};

type TypesOf<P> = P extends { readonly [portTypes]: infer X } ? X : never;
export type PortArgs<P> = TypesOf<P> extends { readonly args: infer A extends readonly unknown[] } ? A : never;
export type PortValue<P> = TypesOf<P> extends { readonly value: infer T } ? T : never;
export type PortError<P> = TypesOf<P> extends { readonly error: infer E } ? E : never;

export type Ports = Readonly<Record<string, AnyPort>>;
export type NoPorts = Readonly<Record<never, AnyPort>>;
export type PortNames<P extends Ports> = { [K in keyof P]: P[K]["name"] }[keyof P];

export const port = <const N extends string>(name: N) => ({
  of: <F extends (...args: never) => unknown, E = never>() =>
    new Port<N, Parameters<F>, ReturnType<F>, E>(name, false, new Slots()),
});

export const cached = <N extends string, A extends readonly unknown[], T, E>(p: Port<N, A, T, E>): Port<N, A, T, E> =>
  p.withCache();
