import { byName, type ByName, type UniqueNames } from "keyed";
import type { BindCtx } from "./methods.ts";
import type { Action } from "./model.ts";
import { clock, type Invocation, type Provider } from "./port.ts";
import type { RuleSet, RuleSetPorts } from "./rules.ts";

export type Bound<Sets extends readonly RuleSet[]> = ByName<Sets>;

type RequiredPorts<Sets extends readonly RuleSet[]> = RuleSetPorts<Sets[number]> | "clock";
type MissingProviders<Sets extends readonly RuleSet[], Ps extends readonly Provider[]> = Exclude<
  RequiredPorts<Sets>,
  Ps[number]["name"]
>;

export function bind<const Sets extends readonly RuleSet[], const Ps extends readonly Provider[]>(
  sets: Sets & UniqueNames<Sets>,
  options: { readonly providers: Ps } & ([MissingProviders<Sets, Ps>] extends [never]
    ? unknown
    : { readonly "provider が足りない port": MissingProviders<Sets, Ps> }),
): Bound<Sets> {
  const scope = {};
  for (const p of options.providers) p.registerIn(scope);
  for (const set of sets) {
    const missing = requiredPorts(set)
      .filter((port) => !port.providedIn(scope))
      .map((port) => port.name);
    if (missing.length > 0) throw new Error(`bind: provider が足りない port: ${missing.join(", ")}`);
  }
  return byName<BindCtx, Sets>(sets, { invocation: () => invocation(scope) });
}

const requiredPorts = (
  set: RuleSet,
): readonly { readonly name: string; readonly providedIn: (scope: object) => boolean }[] =>
  set.kind === "modelRules" ? [clock, ...set.ports] : [clock, ...set.rules.ports];

const invocation = (scope: object): Invocation => {
  const now = clock.nowIn(scope);
  // bind が clock の provider を確かめてから呼ぶので、ここに来るのは壊れたときだけ
  if (now === undefined) throw new Error("bind: clock の provider がありません");
  return { scope, now };
};

export type { Action };
