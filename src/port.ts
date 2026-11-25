import { Result } from "@praha/byethrow";
import { mapValues } from "as-free";

declare const portTypes: unique symbol;

type ImplOf<A extends readonly unknown[], T, E> = (...args: A) => Result.Result<T, E> | Result.ResultAsync<T, E>;

// 1回のメソッド呼び出し。scope は bind ごとに1つで、provider の実装はこれを key に登録する
export type Invocation = { readonly scope: object; readonly now: number };

const register = <I>(impls: WeakMap<object, I>, scope: object, impl: I, name: string): void => {
  // 復帰できない異常: 同じ port の provider を同じ bind に2つ渡している
  if (impls.has(scope)) throw new Error(`bind: port "${name}" の provider が重複しています`);
  impls.set(scope, impl);
};

// provider は、自分の port の型で作った実装を、渡された scope に登録するだけの値。
// port の provider からしか作れないので、port と違う型の実装を登録する provider は作れない
export class Provider<N extends string = string> {
  readonly name: N;
  readonly #register: (scope: object) => void;

  constructor(name: N, register: (scope: object) => void) {
    this.name = name;
    this.#register = register;
    Object.freeze(this);
  }

  readonly registerIn = (scope: object): void => this.#register(scope);
}

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
    if (impl === undefined) throw new Error(`port "${this.name}" の provider がありません`);
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

class Clock {
  readonly kind = "clock";
  readonly name = "clock";
  readonly #impls = new WeakMap<object, () => number>();

  constructor() {
    Object.freeze(this);
  }

  readonly provider = (now: () => number): Provider<"clock"> =>
    new Provider(this.name, (scope) => register(this.#impls, scope, now, this.name));

  readonly valued = (v: number): Provider<"clock"> => this.provider(() => v);

  readonly providedIn = (scope: object): boolean => this.#impls.has(scope);

  readonly nowIn = (scope: object): number | undefined => this.#impls.get(scope)?.();
}
export type { Clock };

type TypesOf<P> = P extends { readonly [portTypes]: infer X } ? X : never;
export type PortArgs<P> = TypesOf<P> extends { readonly args: infer A extends readonly unknown[] } ? A : never;
export type PortValue<P> = TypesOf<P> extends { readonly value: infer T } ? T : never;
export type PortError<P> = TypesOf<P> extends { readonly error: infer E } ? E : never;

export type Ports = Readonly<Record<string, AnyPort>>;
export type NoPorts = Readonly<Record<never, AnyPort>>;
export type PortNames<P extends Ports> = { [K in keyof P]: P[K]["name"] }[keyof P];
// requires に書ける record。各 port が、1回の呼び出しから check に渡す関数を作れることを型で表す
export type Requires = Readonly<Record<string, AnyPort & { readonly resolveIn: (invocation: Invocation) => unknown }>>;

type HasIndex<P> = string extends keyof P
  ? true
  : number extends keyof P
    ? true
    : symbol extends keyof P
      ? true
      : false;
type OptionalKeys<P> = { [K in keyof P]-?: {} extends Pick<P, K> ? K : never }[keyof P];

// index signature や省略できる key があると、bind が確かめる port と check が使う port がずれる
export type StrictRecord<P> =
  HasIndex<P> extends true
    ? { readonly "index signature の record は渡せない": never }
    : [OptionalKeys<P>] extends [never]
      ? unknown
      : { readonly "省略できる key は渡せない": OptionalKeys<P> };

// requires の port ごとに、check に渡す関数を作る
export const resolvePorts = <P extends Requires>(requires: P, invocation: Invocation) =>
  mapValues(requires, (p) => p.resolveIn(invocation));
export type PortFns<P extends Requires> = ReturnType<typeof resolvePorts<P>>;

export const port = <const N extends string>(name: N) => ({
  of: <F extends (...args: never) => unknown, E = never>() =>
    new Port<N, Parameters<F>, ReturnType<F>, E>(name, false, new Slots()),
});

export const cached = <N extends string, A extends readonly unknown[], T, E>(p: Port<N, A, T, E>): Port<N, A, T, E> =>
  p.withCache();

export const clock: Clock = new Clock();

type Providable<N extends string, I> = { readonly provider: (impl: I) => Provider<N> };
type Valuable<N extends string, V> = { readonly valued: (v: V) => Provider<N> };

export const provide = Object.assign(
  <N extends string, I>(target: Providable<N, I>, impl: NoInfer<I>): Provider<N> => target.provider(impl),
  { value: <N extends string, V>(target: Valuable<N, V>, v: NoInfer<V>): Provider<N> => target.valued(v) },
);
