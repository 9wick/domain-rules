import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expectTypeOf, test } from "vite-plus/test";
import { bind } from "./bind.ts";
import { defineModel } from "./definition/model.ts";
import { rule } from "./pipeline/rule.ts";
import { ruleset } from "./pipeline/ruleset.ts";
import { always } from "./pipeline/when/step.ts";
import { clock } from "./port/clock.ts";
import { port } from "./port/port.ts";
import { provide } from "./port/provider.ts";
import { modelRules } from "./rule-set/model-rules.ts";

const item = defineModel<string>()({
  name: "item",
  schema: { input: v.object({ id: v.optional(v.string()) }), persisted: v.object({ id: v.string() }) },
});
const newId = port("newId").of<() => string>();
const assign = rule(item.onSave, {
  name: "id",
  requires: { newId },
  when: always,
  check: async (_, { newId }) =>
    Result.pipe(
      await newId(),
      Result.map((id) => ({ next: { id } })),
    ),
});
const items = modelRules(item).save(ruleset(assign));
const providers = [provide.value(newId, "i"), provide.value(clock, 0)] as const;

test("返り値は、rule の組の名前を key にしたメソッドの組", () => {
  expectTypeOf(bind([items], { providers }))
    .toHaveProperty("item")
    .toHaveProperty("create")
    .toBeFunction();
});

test("bind には、長さの決まった rule の組の tuple だけを渡せる", () => {
  const sets = [items];
  // @ts-expect-error 配列は要素が無いことがあり、型にあるメソッドが値に無いことがある
  bind(sets, { providers });
});
