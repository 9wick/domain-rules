import { Result } from "@praha/byethrow";
import { portFns } from "./proven.ts";
import { implFor } from "./unchecked.ts";

declare const portTypes: unique symbol;

type ImplOf<A extends readonly unknown[], T, E> = (...args: A) => Result.Result<T, E> | Result.ResultAsync<T, E>;

// port は宣言だけで、実装は provider であとから渡す。引数・値・失敗の型は宣言の型の上にだけある。
// 型引数は不変にする。広い型の port として扱えると、宣言と違う型の実装を登録できてしまうため
export class Port<N extends string, in out A extends readonly unknown[], in out T, in out E> {
  declare readonly [portTypes]: { readonly args: A; readonly value: T; readonly error: E };
  readonly kind = "port";
  readonly name: N;
  readonly token: symbol;
  readonly cached: boolean;

  constructor(name: N, token: symbol, cached: boolean) {
    this.name = name;
    this.token = token;
    this.cached = cached;
    Object.freeze(this);
  }

  // provide から呼ぶ。method ではなく関数の property にするのは、method の引数は広い型の object の型へ代入するときに
  // 確かめられず、宣言と違う型の実装を渡せてしまうため
  readonly provider = (impl: ImplOf<A, T, E>): Provider<N> =>
    Object.freeze({ kind: "port", name: this.name, token: this.token, impl });

  readonly valued = (v: T): Provider<N> => this.provider(() => Result.succeed(v));
}

// 型引数を問わない port。型の上で port の一覧や record を持つためで、実装の登録には使えない
export type AnyPort = {
  readonly kind: "port";
  readonly name: string;
  readonly token: symbol;
  readonly cached: boolean;
};

class Clock {
  readonly kind = "clock";
  readonly name = "clock";
  readonly token = Symbol("clock");

  constructor() {
    Object.freeze(this);
  }

  readonly provider = (now: () => number): Provider<"clock"> =>
    Object.freeze({ kind: "clock", name: this.name, token: this.token, now });

  readonly valued = (v: number): Provider<"clock"> => this.provider(() => v);
}
export type { Clock };

type TypesOf<P> = P extends { readonly [portTypes]: infer X } ? X : never;
export type PortArgs<P> = TypesOf<P> extends { readonly args: infer A extends readonly unknown[] } ? A : never;
export type PortValue<P> = TypesOf<P> extends { readonly value: infer T } ? T : never;
export type PortError<P> = TypesOf<P> extends { readonly error: infer E } ? E : never;

export type Ports = Readonly<Record<string, AnyPort>>;
export type NoPorts = Readonly<Record<never, AnyPort>>;
export type PortFns<P extends Ports> = {
  readonly [K in keyof P]: (...args: PortArgs<P[K]>) => Promise<PortValue<P[K]>>;
};
export type PortErrors<P extends Ports> = { [K in keyof P]: PortError<P[K]> }[keyof P];
export type PortNames<P extends Ports> = { [K in keyof P]: P[K]["name"] }[keyof P];

export const port = <const N extends string>(name: N) => ({
  of: <F extends (...args: never) => unknown, E = never>() =>
    new Port<N, Parameters<F>, ReturnType<F>, E>(name, Symbol(name), false),
});

export const cached = <N extends string, A extends readonly unknown[], T, E>(p: Port<N, A, T, E>): Port<N, A, T, E> =>
  new Port<N, A, T, E>(p.name, p.token, true);

export const clock: Clock = new Clock();

export type Impl<P extends AnyPort> = (
  ...args: PortArgs<P>
) => Result.Result<PortValue<P>, PortError<P>> | Result.ResultAsync<PortValue<P>, PortError<P>>;

// provider は port の宣言の token で引く。時計の provider は時刻を返す関数を、型を消さずに持つ
export type Provider<N extends string = string> =
  | { readonly kind: "port"; readonly name: N; readonly token: symbol; readonly impl: (...args: never) => unknown }
  | { readonly kind: "clock"; readonly name: N; readonly token: symbol; readonly now: () => number };

type Providable<N extends string, I> = { readonly provider: (impl: I) => Provider<N> };
type Valuable<N extends string, V> = { readonly valued: (v: V) => Provider<N> };

export const provide = Object.assign(
  <N extends string, I>(target: Providable<N, I>, impl: NoInfer<I>): Provider<N> => target.provider(impl),
  { value: <N extends string, V>(target: Valuable<N, V>, v: NoInfer<V>): Provider<N> => target.valued(v) },
);

export type Impls = ReadonlyMap<symbol, (...args: never) => unknown>;

export type PortCall = <P extends AnyPort>(
  p: P,
  args: PortArgs<P>,
) => Promise<Result.Result<PortValue<P>, PortError<P>>>;

const requireImpl = <P extends AnyPort>(impls: Impls, p: P): Impl<P> => {
  const impl = implFor(impls, p);
  // bind が provider の不足を確かめてから呼ぶので、ここに来るのは壊れたときだけ
  if (impl === undefined) throw new Error(`port "${p.name}" の provider がありません`);
  return impl;
};

// 同じ引数の呼び出しを1回の呼び出しの中で使い回す
const memoize = <P extends AnyPort>(impl: Impl<P>): Impl<P> => {
  const results = new Map<string, ReturnType<Impl<P>>>();
  return (...args) => {
    const key = JSON.stringify(args);
    const hit = results.get(key);
    if (hit !== undefined) return hit;
    const pending = impl(...args);
    results.set(key, pending);
    return pending;
  };
};

export const portCaller = (impls: Impls): PortCall => {
  const memos = new Map<symbol, (...args: never) => unknown>();
  const memoFor = <P extends AnyPort>(p: P): Impl<P> => {
    const memo = implFor(memos, p);
    if (memo !== undefined) return memo;
    const created = memoize(requireImpl(impls, p));
    memos.set(p.token, created);
    return created;
  };
  return async (p, args) => (p.cached ? memoFor(p) : requireImpl(impls, p))(...args);
};

class PortFailed<E> {
  readonly error: E;
  constructor(error: E) {
    this.error = error;
  }
}

type PortErrorMap<P extends Ports> = { [K in keyof P]: PortError<P[K]> };

// check の中では port の成功の値だけを見せたいので、失敗は throw で check を抜けさせる。
// check が throw を握りつぶして成功を返しても線路を止められるよう、最初の失敗を別に覚えておく
export const runWithPorts = async <P extends Ports, T, E>(
  call: PortCall,
  requires: P | undefined,
  check: (fns: PortFns<P>) => Result.Result<T, E> | Promise<Result.Result<T, E>>,
): Promise<Result.Result<T, E | PortErrors<P>>> => {
  let failed: PortFailed<PortErrors<P>> | undefined;
  const fns = portFns(requires, async <K extends keyof P>(p: P[K], args: PortArgs<P[K]>) => {
    const r = await call(p, args);
    if (Result.isFailure(r)) {
      const error: PortErrorMap<P>[K] = r.error;
      failed ??= new PortFailed<PortErrors<P>>(error);
      throw failed;
    }
    return r.value;
  });
  try {
    const result = await check(fns);
    return failed === undefined ? result : Result.fail(failed.error);
  } catch (e) {
    if (failed !== undefined && e === failed) return Result.fail(failed.error);
    throw e;
  }
};
