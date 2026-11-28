import type { RulesetEvents } from "./pipeline/ruleset.ts";
import type { Success } from "./shared/result.ts";

// メソッドの成功の値が持つ events から引く。rule の組と bind の戻り値は、どちらもメソッドの型から引くので、
// イベントの型を別に持たずに済む
type EventsOfMethod<F> = F extends (...args: never[]) => Promise<infer R>
  ? R extends Success<{ readonly events: readonly (infer Ev)[] }>
    ? Ev
    : never
  : never;
type EventsOfMethods<Ms> = { readonly [K in keyof Ms]: EventsOfMethod<Ms[K]> }[keyof Ms];

// emit・ruleset・modelRules / actionRules・bind の戻り値から、発行しうるイベントの型を取り出す
export type DomainEvent<X> = X extends { readonly kind: "rule"; readonly event?: (s: never) => infer Ev }
  ? Ev
  : X extends { readonly kind: "ruleset" }
    ? RulesetEvents<X>
    : X extends { readonly resolveIn: (ctx: never) => infer Ms }
      ? EventsOfMethods<Ms>
      : { readonly [K in keyof X]: EventsOfMethods<X[K]> }[keyof X];
