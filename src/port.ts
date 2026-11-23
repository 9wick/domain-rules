import { Result } from "@praha/byethrow";
import { implFor, portFns } from "./unchecked.ts";

declare const portTypes: unique symbol;

// port は宣言だけで、実装は provider であとから渡す。引数・値・失敗の型は宣言の型の上にだけある
export class Port<
  N extends string = string,
  A extends readonly unknown[] = readonly unknown[],
  T = unknown,
  E = unknown,
> {
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
}

export type Clock = { readonly kind: "clock"; readonly name: "clock"; readonly token: symbol };

export type PortArgs<P> = P extends Port<string, infer A> ? A : never;
export type PortValue<P> = P extends Port<string, readonly unknown[], infer T> ? T : never;
export type PortError<P> = P extends Port<string, readonly unknown[], unknown, infer E> ? E : never;

export type Ports = Readonly<Record<string, Port>>;
export type NoPorts = Readonly<Record<never, Port>>;
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

export const clock: Clock = Object.freeze({ kind: "clock", name: "clock", token: Symbol("clock") });

export type Impl<P extends Port> = (
  ...args: PortArgs<P>
) => Result.Result<PortValue<P>, PortError<P>> | Result.ResultAsync<PortValue<P>, PortError<P>>;

// provider は port の宣言の token で引く。実装の型は provide の引数で port の型に合わせてある
export type Provider<N extends string = string> = {
  readonly name: N;
  readonly token: symbol;
  readonly impl: (...args: never) => unknown;
};

export function provide<P extends Port>(target: P, impl: Impl<P>): Provider<P["name"]>;
export function provide(target: Clock, impl: () => number): Provider<"clock">;
export function provide(target: Port | Clock, impl: (...args: never) => unknown): Provider {
  return Object.freeze({ name: target.name, token: target.token, impl });
}

function value<P extends Port>(target: P, v: PortValue<P>): Provider<P["name"]>;
function value(target: Clock, v: number): Provider<"clock">;
function value(target: Port | Clock, v: unknown): Provider {
  const impl = target.kind === "clock" ? () => v : () => Result.succeed(v);
  return Object.freeze({ name: target.name, token: target.token, impl });
}
provide.value = value;

export type Impls = ReadonlyMap<symbol, (...args: never) => unknown>;

export type PortCall = <P extends Port>(p: P, args: PortArgs<P>) => Promise<Result.Result<PortValue<P>, PortError<P>>>;

const requireImpl = <P extends Port>(impls: Impls, p: P): Impl<P> => {
  const impl = implFor(impls, p);
  // bind が provider の不足を確かめてから呼ぶので、ここに来るのは壊れたときだけ
  if (impl === undefined) throw new Error(`port "${p.name}" の provider がありません`);
  return impl;
};

// 同じ引数の呼び出しを1回の呼び出しの中で使い回す
const memoize = <P extends Port>(impl: Impl<P>): Impl<P> => {
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
  const memoFor = <P extends Port>(p: P): Impl<P> => {
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
