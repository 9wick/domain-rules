import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { always, bind, clock, modelRules, open, plan, provide, rule, ruleset } from "../index.ts";
import { assignId, item, member } from "../testing/fixtures.ts";

test("when が当たらない rule は check を呼ばず、状態を変えない", async () => {
  let called = false;
  const never = rule(item.onSave, {
    name: "never",
    when: () => false,
    check: () => ((called = true), Result.fail("X")),
  });
  const domain = bind([modelRules(item).save(ruleset(never).add(assignId))], {
    providers: [provide.value(clock, 0)],
  });
  expect(open(Result.unwrap(await domain.item.create({ input: { n: 1 }, actor: member }))).next).toEqual({
    id: "new",
    n: 1,
  });
  expect(called).toBe(false);
});

test("add は元の ruleset を変えず、新しい ruleset を返す", () => {
  const base = ruleset(assignId);
  base.add(rule(item.onSave, { name: "other", when: always, check: () => Result.succeed() }));
  expect(plan(modelRules(item).save(base)).save?.map((r) => r.name)).toEqual(["id"]);
});
