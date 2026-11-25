import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { always, bind, cached, clock, modelRules, open, port, provide, rule, ruleset } from "../index.ts";
import { item, lookup, member, twice, uncachedLookup } from "../testing/fixtures.ts";

test("cached の port は1回の呼び出しの中でだけ、同じ引数の結果を使い回す", async () => {
  const calls: string[] = [];
  const domain = bind([modelRules(item).save(ruleset(twice("a")).add(twice("b")))], {
    providers: [
      provide(lookup, (n) => (calls.push(`lookup(${n})`), Result.succeed(n))),
      provide(uncachedLookup, (n) => (calls.push(`uncached(${n})`), Result.succeed(n))),
      provide(clock, () => 0),
    ],
  });
  await domain.item.create({ input: { n: 1 }, actor: member });
  expect(calls).toEqual(["lookup(1)", "uncached(1)", "uncached(1)"]);
  await domain.item.create({ input: { n: 1 }, actor: member });
  expect(calls.filter((c) => c === "lookup(1)")).toHaveLength(2);
});

test("cached は元の宣言の provider を使う", async () => {
  const raw = port("raw").of<(n: number) => number>();
  const cachedRaw = cached(raw);
  const read = rule(item.onSave, {
    name: "read",
    when: always,
    requires: { cachedRaw },
    check: async ({ next }, { cachedRaw }) =>
      Result.pipe(
        await cachedRaw(next.n),
        Result.map((n) => ({ next: { id: String(n) } })),
      ),
  });
  const domain = bind([modelRules(item).save(ruleset(read))], {
    providers: [provide(raw, (n) => Result.succeed(n + 1)), provide.value(clock, 0)],
  });
  const result = await domain.item.create({ input: { n: 2 }, actor: member });
  expect(open(Result.unwrap(result)).next.id).toBe("3");
});
