import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { always, bind, clock, modelRules, port, provide, rule, ruleset } from "../index.ts";
import { item, member } from "../testing/fixtures.ts";

test("check が throw した例外は握りつぶさない", async () => {
  const boom = rule(item.onSave, {
    name: "boom",
    when: always,
    check: (): Result.Result<{ next: { id: string } }, never> => {
      throw new Error("bug");
    },
  });
  const domain = bind([modelRules(item).save(ruleset(boom))], { providers: [provide.value(clock, 0)] });
  await expect(domain.item.create({ input: { n: 1 }, actor: member })).rejects.toThrow("bug");
});

const failingRule = <E>(name: string, onFailure: (e: "DOWN") => E) => {
  const failing = port("failing").of<() => number, "DOWN">();
  const r = rule(item.onSave, {
    name,
    requires: { failing },
    when: always,
    check: async (_, { failing }) => {
      const n = await failing();
      return Result.isFailure(n) ? Result.fail(onFailure(n.error)) : Result.succeed({ next: { id: String(n.value) } });
    },
  });
  return bind([modelRules(item).save(ruleset(r))], {
    providers: [provide(failing, () => Result.fail("DOWN" as const)), provide.value(clock, 0)],
  });
};

test("check が返した port の失敗が、rule の失敗になる", async () => {
  const r = await failingRule("pass", (e) => e).item.create({ input: { n: 1 }, actor: member });
  expect(Result.unwrapError(r)).toEqual({ step: "pass", error: "DOWN" });
});

test("check は port の失敗を別の値にして返せる", async () => {
  const r = await failingRule("mapped", () => "UNAVAILABLE" as const).item.create({ input: { n: 1 }, actor: member });
  expect(Result.unwrapError(r)).toEqual({ step: "mapped", error: "UNAVAILABLE" });
});
