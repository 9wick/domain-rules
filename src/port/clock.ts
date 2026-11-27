import type { Context, Provider } from "./provider.ts";
import { Slot } from "./slot.ts";

class Clock {
  readonly kind = "clock";
  readonly name = "clock";
  readonly #slot = new Slot<"clock", () => number>("clock");

  constructor() {
    Object.freeze(this);
  }

  readonly provider = (now: () => number): Provider<"clock"> => this.#slot.provider(now);

  readonly valued = (v: number): Provider<"clock"> => this.provider(() => v);

  readonly providedIn = (context: Context): boolean => this.#slot.providedIn(context);

  readonly nowIn = (context: Context): number | undefined => this.#slot.implIn(context)?.();
}
export type { Clock };

export const clock: Clock = new Clock();
