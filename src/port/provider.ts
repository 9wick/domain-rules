import { Panic } from "../shared/panic.ts";

export const register = <I>(impls: WeakMap<object, I>, scope: object, impl: I, name: string): void => {
  // 復帰できない異常: 同じ port の provider を同じ bind に2つ渡している
  if (impls.has(scope)) throw new Panic(`bind: port "${name}" の provider が重複しています`);
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

type Providable<N extends string, I> = { readonly provider: (impl: I) => Provider<N> };
type Valuable<N extends string, V> = { readonly valued: (v: V) => Provider<N> };

export const provide = Object.assign(
  <N extends string, I>(target: Providable<N, I>, impl: NoInfer<I>): Provider<N> => target.provider(impl),
  { value: <N extends string, V>(target: Valuable<N, V>, v: NoInfer<V>): Provider<N> => target.valued(v) },
);
