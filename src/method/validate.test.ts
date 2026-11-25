import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { bind, clock, modelRules, provide, ruleset } from "../index.ts";
import { item, lookup, member, twice, uncachedLookup } from "../testing/fixtures.ts";

test("prototype の名前の項目も schema にない項目として失敗する", async () => {
  const domain = bind([modelRules(item).save(ruleset(twice("a")))], {
    providers: [provide.value(lookup, 1), provide.value(uncachedLookup, 1), provide.value(clock, 0)],
  });
  const r = await domain.item.create({
    // @ts-expect-error 型に合わない入力を渡したときの実行時の振る舞いを確かめる
    input: { n: "x", constructor: 1 },
    actor: member,
  });
  expect(Result.unwrapError(r)).toMatchObject({
    step: "input",
    error: { issues: [{ path: ["constructor"] }, { path: [{ key: "n" }] }] },
  });
});
