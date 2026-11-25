import { Provider, register } from "./provider.ts";

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

export const clock: Clock = new Clock();
