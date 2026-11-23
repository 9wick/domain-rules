import { Result } from "@praha/byethrow";
import { callErased, withPhantom, type ErasedFn, type Phantom } from "./erased.ts";

type PortInfo<A, T, E> = { readonly args: A; readonly value: T; readonly error: E };

export type Port<
  N extends string = string,
  A extends readonly unknown[] = readonly unknown[],
  T = unknown,
  E = unknown,
> = {
  readonly kind: "port";
  readonly name: N;
  readonly cached: boolean;
  readonly token: symbol;
} & Phantom<PortInfo<A, T, E>>;

export type Clock = { readonly kind: "clock"; readonly name: "clock"; readonly token: symbol };

type InfoOf<P> = P extends Phantom<infer I> ? I : never;
export type PortArgs<P> = InfoOf<P> extends { readonly args: infer A extends readonly unknown[] } ? A : never;
export type PortValue<P> = InfoOf<P> extends PortInfo<readonly unknown[], infer T, unknown> ? T : never;
export type PortError<P> = InfoOf<P> extends PortInfo<readonly unknown[], unknown, infer E> ? E : never;

export type Ports = Record<string, Port>;
export type PortFns<P extends Ports> = {
  readonly [K in keyof P]: (...args: PortArgs<P[K]>) => Promise<PortValue<P[K]>>;
};
export type PortErrors<P extends Ports> = { [K in keyof P]: PortError<P[K]> }[keyof P];

export const port = <const N extends string>(name: N) => ({
  of: <F extends ErasedFn, E = never>(): Port<N, Parameters<F>, ReturnType<F>, E> =>
    withPhantom<Port<N, Parameters<F>, ReturnType<F>, E>>(
      Object.freeze({ kind: "port", name, token: Symbol(name), cached: false }),
    ),
});

export const cached = <P extends Port>(p: P): P => Object.freeze({ ...p, cached: true });

export const clock: Clock = Object.freeze({ kind: "clock", name: "clock", token: Symbol("clock") });

type Impl<P extends Port> = (
  ...args: PortArgs<P>
) => Result.Result<PortValue<P>, PortError<P>> | Result.ResultAsync<PortValue<P>, PortError<P>>;

// port の provider は Result を、clock の provider は時刻の数を返す。どちらを返すかは provide の overload で型を確かめる
export type Provider<N extends string = string> = {
  readonly name: N;
  readonly token: symbol;
  readonly impl: ErasedFn;
};

export function provide<P extends Port>(target: P, impl: Impl<P>): Provider<P["name"]>;
export function provide(target: Clock, impl: () => number): Provider<"clock">;
export function provide(target: Port | Clock, impl: ErasedFn): Provider {
  return Object.freeze({ name: target.name, token: target.token, impl });
}

function value<P extends Port>(target: P, v: PortValue<P>): Provider<P["name"]>;
function value(target: Clock, v: number): Provider<"clock">;
function value(target: Port | Clock, v: unknown): Provider {
  const impl = target.kind === "clock" ? () => v : () => Result.succeed(v);
  return Object.freeze({ name: target.name, token: target.token, impl });
}
provide.value = value;

export type PortCall = (p: Port, args: readonly unknown[]) => Promise<Result.Result<unknown, unknown>>;

export const portCaller = (impls: ReadonlyMap<symbol, ErasedFn>): PortCall => {
  const cache = new Map<symbol, Map<string, Promise<Result.Result<unknown, unknown>>>>();
  return (p, args) => {
    const impl = impls.get(p.token);
    const run = async (): Promise<Result.Result<unknown, unknown>> => {
      if (impl === undefined) return Result.fail({ code: "PROVIDER_MISSING", port: p.name });
      const r: unknown = await callErased(impl, ...args);
      return Result.isResult<unknown, unknown>(r)
        ? r
        : Result.fail({ code: "PROVIDER_RETURNED_NON_RESULT", port: p.name });
    };
    if (!p.cached) return run();
    const byArgs = cache.get(p.token) ?? new Map<string, Promise<Result.Result<unknown, unknown>>>();
    cache.set(p.token, byArgs);
    const key = JSON.stringify(args);
    const hit = byArgs.get(key);
    if (hit !== undefined) return hit;
    const pending = run();
    byArgs.set(key, pending);
    return pending;
  };
};

class PortFailed {
  readonly error: unknown;
  constructor(error: unknown) {
    this.error = error;
  }
}

type PortFnsRuntime = Readonly<Record<string, (...args: readonly unknown[]) => Promise<unknown>>>;
type CheckResult = Result.Result<unknown, unknown> | Promise<Result.Result<unknown, unknown>>;

// check の中では port の成功の値だけを見せたいので、失敗は throw で check を抜けさせる。
// check が throw を握りつぶして成功を返しても線路を止められるよう、最初の失敗を別に覚えておく
export const runWithPorts = async (
  call: PortCall,
  requires: Ports,
  check: (fns: PortFnsRuntime) => CheckResult,
): Promise<Result.Result<unknown, unknown>> => {
  let failed: PortFailed | undefined;
  const fns: PortFnsRuntime = Object.fromEntries(
    Object.entries(requires).map(([key, p]) => [
      key,
      async (...args: readonly unknown[]) => {
        const r = await call(p, args);
        if (Result.isFailure(r)) {
          failed ??= new PortFailed(r.error);
          throw failed;
        }
        return r.value;
      },
    ]),
  );
  try {
    const result = await check(fns);
    return failed === undefined ? result : Result.fail(failed.error);
  } catch (e) {
    if (failed !== undefined && e === failed) return Result.fail(failed.error);
    throw e;
  }
};
