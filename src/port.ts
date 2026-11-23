import { Result } from "@praha/byethrow";

declare const portTypes: unique symbol;

export type Port<N extends string = string, A extends readonly unknown[] = any, T = any, E = any> = {
  readonly kind: "port";
  readonly name: N;
  readonly cached: boolean;
  readonly token: symbol;
  readonly [portTypes]: { readonly args: A; readonly value: T; readonly error: E };
};

export type Clock = { readonly kind: "clock"; readonly name: "clock"; readonly token: symbol };

export type PortArgs<P> = P extends Port<string, infer A, any, any> ? A : never;
export type PortValue<P> = P extends Port<string, any, infer T, any> ? T : never;
export type PortError<P> = P extends Port<string, any, any, infer E> ? E : never;

export type Ports = Record<string, Port>;
export type PortFns<P extends Ports> = {
  readonly [K in keyof P]: (...args: PortArgs<P[K]>) => Promise<PortValue<P[K]>>;
};
export type PortErrors<P extends Ports> = { [K in keyof P]: PortError<P[K]> }[keyof P];

export const port = <const N extends string>(name: N) => ({
  of: <F extends (...args: any[]) => unknown, E = never>(): Port<N, Parameters<F>, ReturnType<F>, E> =>
    Object.freeze({ kind: "port", name, token: Symbol(name), cached: false }) as unknown as Port<
      N,
      Parameters<F>,
      ReturnType<F>,
      E
    >,
});

export const cached = <P extends Port>(p: P): P => Object.freeze({ ...p, cached: true });

export const clock: Clock = Object.freeze({ kind: "clock", name: "clock", token: Symbol("clock") });

type Impl<P extends Port> = (
  ...args: PortArgs<P>
) => Result.Result<PortValue<P>, PortError<P>> | Result.ResultAsync<PortValue<P>, PortError<P>>;

export type Provider<N extends string = string> = {
  readonly name: N;
  readonly token: symbol;
  readonly impl: (...args: any[]) => unknown;
};

export function provide<P extends Port>(target: P, impl: Impl<P>): Provider<P["name"]>;
export function provide(target: Clock, impl: () => number): Provider<"clock">;
export function provide(target: Port | Clock, impl: (...args: any[]) => unknown): Provider {
  return Object.freeze({ name: target.name, token: target.token, impl });
}

function value<P extends Port>(target: P, v: PortValue<P>): Provider<P["name"]>;
function value(target: Clock, v: number): Provider<"clock">;
function value(target: Port | Clock, v: unknown): Provider {
  return target.kind === "clock" ? provide(target, () => v as number) : provide(target, () => Result.succeed(v));
}
provide.value = value;

export type PortCall = (p: Port, args: readonly unknown[]) => Promise<Result.Result<unknown, unknown>>;

export const portCaller = (impls: ReadonlyMap<symbol, (...args: any[]) => unknown>): PortCall => {
  const cache = new Map<symbol, Map<string, Promise<Result.Result<unknown, unknown>>>>();
  return (p, args) => {
    const run = async () => (await impls.get(p.token)!(...args)) as Result.Result<unknown, unknown>;
    if (!p.cached) return run();
    const byArgs = cache.get(p.token) ?? new Map();
    cache.set(p.token, byArgs);
    const key = JSON.stringify(args);
    const hit = byArgs.get(key);
    if (hit) return hit;
    const pending = run();
    byArgs.set(key, pending);
    return pending;
  };
};

class PortFailed {
  constructor(readonly error: unknown) {}
}

// check の中では port の成功の値だけを見せたいので、失敗は throw で check を抜けさせる。
// check が throw を握りつぶして成功を返しても線路を止められるよう、最初の失敗を別に覚えておく
export const runWithPorts = async (
  call: PortCall,
  requires: Ports,
  check: (fns: Record<string, (...args: unknown[]) => Promise<unknown>>) => unknown,
): Promise<Result.Result<unknown, unknown>> => {
  let failed: PortFailed | undefined;
  const fns = Object.fromEntries(
    Object.entries(requires).map(([key, p]) => [
      key,
      async (...args: unknown[]) => {
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
    const result = (await check(fns)) as Result.Result<unknown, unknown>;
    return failed ? Result.fail(failed.error) : result;
  } catch (e) {
    if (failed && e === failed) return Result.fail(failed.error);
    throw e;
  }
};
