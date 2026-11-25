import { expect, test } from "vite-plus/test";
import { bind, clock, modelRules, port, provide, ruleset } from "./index.ts";
import { item, lookup, twice, uncachedLookup } from "./testing/fixtures.ts";

test("同名の別宣言の provider では port を満たせない", () => {
  const otherLookup = port("lookup").of<(n: number) => string>();
  const set = modelRules(item).save(ruleset(twice("a")));
  expect(() =>
    bind([set], {
      providers: [provide.value(otherLookup, "wrong"), provide.value(uncachedLookup, 1), provide.value(clock, 0)],
    }),
  ).toThrow("provider が足りない port: lookup");
});

test("bind には、長さの決まった rule の組の tuple だけを渡せる", () => {
  const sets = [modelRules(item).save(ruleset(twice("a")))];
  const providers = [provide.value(lookup, 1), provide.value(uncachedLookup, 1), provide.value(clock, 0)] as const;
  // @ts-expect-error 配列は要素が無いことがあり、型にあるメソッドが値に無いことがある
  expect(() => bind(sets, { providers })).not.toThrow();
});
