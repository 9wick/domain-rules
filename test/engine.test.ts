import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vitest";
import { always, bind, cached, clock, model, modelRules, port, provide, rule } from "../src/index.ts";

const item = model({ name: "item", schema: { input: v.object({ id: v.optional(v.string()), n: v.number() }), persisted: v.object({ id: v.string(), n: v.number() }) } });
const lookup = cached(port("lookup").of<(n: number) => number, never>());
const uncachedLookup = port("uncachedLookup").of<(n: number) => number, never>();

const twice = (name: string) =>
  rule(item.save, {
    name,
    requires: { lookup, uncachedLookup },
    when: always,
    check: async ({ next }, ports) => {
      await ports.lookup(next.n);
      await ports.uncachedLookup(next.n);
      return Result.succeed({ next: { id: "i" } });
    },
  });

test("cached の port は1回の呼び出しの中でだけ、同じ引数の結果を使い回す", async () => {
  const calls: string[] = [];
  const domain = bind([modelRules(item, { save: [twice("a"), twice("b")] })], {
    providers: [
      provide(lookup, (n) => (calls.push(`lookup(${n})`), Result.succeed(n))),
      provide(uncachedLookup, (n) => (calls.push(`uncached(${n})`), Result.succeed(n))),
      provide(clock, () => 0),
    ],
  });
  await domain.item.create({ input: { n: 1 }, actor: { id: "usr_1" as never, role: "MEMBER" } });
  expect(calls).toEqual(["lookup(1)", "uncached(1)", "uncached(1)"]);
  await domain.item.create({ input: { n: 1 }, actor: { id: "usr_1" as never, role: "MEMBER" } });
  expect(calls.filter((c) => c === "lookup(1)")).toHaveLength(2);
});

test("load がない model の rule の組は create だけを持つ", () => {
  const domain = bind([modelRules(item, { save: [twice("a")] })], {
    providers: [provide.value(lookup, 1), provide.value(uncachedLookup, 1), provide.value(clock, 0)],
  });
  expect(Object.keys(domain.item)).toEqual(["create"]);
});

test("check が throw した例外は握りつぶさない", async () => {
  const boom = rule(item.save, {
    name: "boom",
    when: always,
    check: (): Result.Result<{ next: { id: string } }, never> => {
      throw new Error("bug");
    },
  });
  const domain = bind([modelRules(item, { save: [boom] })], { providers: [provide.value(clock, 0)] });
  await expect(domain.item.create({ input: { n: 1 }, actor: { id: "usr_1" as never, role: "MEMBER" } })).rejects.toThrow("bug");
});
