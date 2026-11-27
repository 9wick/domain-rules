import { fromEntries, mapValues } from "as-free";
import type { Action } from "./definition/action.ts";
import type { BindCtx } from "./method/context.ts";
import { clock } from "./port/clock.ts";
import { invocationOf, type Invocation } from "./port/invocation.ts";
import { Context, type Provider } from "./port/provider.ts";
import type { RulesetPorts } from "./pipeline/ruleset.ts";
import type { RuleSet } from "./rule-set/rule-set.ts";
import { Panic } from "./shared/panic.ts";
import type { UniqueNames } from "./shared/unique-names.ts";

type RequiredPorts<Sets extends readonly RuleSet[]> = RulesetPorts<Sets[number]> | "clock";
type MissingProviders<Sets extends readonly RuleSet[], Ps extends readonly Provider[]> = Exclude<
  RequiredPorts<Sets>,
  Ps[number]["name"]
>;

// bind の返り値の型。domain 層へのアクセス obj で、名前を付けて受け渡すときに使う
export type Domain<Sets extends readonly RuleSet[]> = ReturnType<typeof bind<Sets, readonly Provider[]>>;

export function bind<const Sets extends readonly RuleSet[], const Ps extends readonly Provider[]>(
  sets: Sets & UniqueNames<Sets>,
  options: { readonly providers: Ps } & ([MissingProviders<Sets, Ps>] extends [never]
    ? unknown
    : { readonly "provider が足りない port": MissingProviders<Sets, Ps> }),
) {
  const context = new Context(options.providers);
  const names = new Set<string>();
  for (const set of sets) {
    // 復帰できない異常: 同じ名前の rule の組を2つ渡している。型でも弾くが、tuple でない配列などで来たときに後の組で黙って上書きしない
    if (names.has(set.name)) throw new Panic(`bind: "${set.name}" の rule の組が重複しています`);
    names.add(set.name);
    const missing = requiredPorts(set)
      .filter((port) => !port.providedIn(context))
      .map((port) => port.name);
    if (missing.length > 0) throw new Panic(`bind: provider が足りない port: ${missing.join(", ")}`);
  }
  const ctx: BindCtx = { invocation: () => invocation(context) };
  const list: Sets = sets;
  return fromEntries(mapValues(list, (set) => [set.name, set.resolveIn(ctx)] as const));
}

const requiredPorts = (
  set: RuleSet,
): readonly { readonly name: string; readonly providedIn: (context: Context) => boolean }[] => [clock, ...set.ports];

const invocation = (context: Context): Invocation => {
  const now = clock.nowIn(context);
  // bind が clock の provider を確かめてから呼ぶので、ここに来るのは壊れたときだけ
  if (now === undefined) throw new Panic("bind: clock の provider がありません");
  return invocationOf(context, now);
};

export type { Action };
