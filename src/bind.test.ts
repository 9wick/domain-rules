import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { bind } from "./bind.ts";
import { defineModel } from "./definition/model.ts";
import { open } from "./method/seal.ts";
import { rule } from "./pipeline/rule.ts";
import { ruleset } from "./pipeline/ruleset.ts";
import { always } from "./pipeline/when/step.ts";
import { clock } from "./port/clock.ts";
import { port } from "./port/port.ts";
import { provide } from "./port/provider.ts";
import { modelRules } from "./rule-set/model-rules.ts";
import { Panic } from "./shared/panic.ts";

const item = defineModel<string>()({
  name: "item",
  schema: {
    key: v.object({ id: v.optional(v.string()) }),
    value: v.object({}),
    persisted: v.object({ id: v.string() }),
  },
});
const newId = port("newId").of<() => string>();
const stamped = rule(item.onSave, {
  id: "idAndTime",
  description: "id と時刻",
  requires: { newId },
  when: always,
  check: async ({ now }, { newId }) =>
    Result.pipe(
      await newId(),
      Result.map((id) => ({ next: { id: `${id}@${now}` } })),
    ),
});
const items = modelRules(item).save(ruleset(stamped));

test("rule の組の名前ごとに、provider の実装と時計で動くメソッドを返す", async () => {
  const domain = bind([items], { providers: [provide.value(newId, "i1"), provide.value(clock, 42)] });
  const r = await domain.item.create({ input: {}, actor: "op" });
  expect(open(Result.unwrap(r)).next).toEqual({ id: "i1@42" });
});

test("bind ごとに provider を分ける", async () => {
  const a = bind([items], { providers: [provide.value(newId, "a"), provide.value(clock, 0)] });
  const b = bind([items], { providers: [provide.value(newId, "b"), provide.value(clock, 0)] });
  const ids = [await a.item.create({ input: {}, actor: "op" }), await b.item.create({ input: {}, actor: "op" })].map(
    (r) => open(Result.unwrap(r)).next.id,
  );
  expect(ids).toEqual(["a@0", "b@0"]);
});

test("provider が足りない port があれば Panic にする", () => {
  // @ts-expect-error newId の provider がない
  expect(() => bind([items], { providers: [provide.value(clock, 0)] })).toThrow("missing providers for ports: newId");
  // @ts-expect-error clock の provider がない
  expect(() => bind([items], { providers: [provide.value(newId, "i")] })).toThrow(Panic);
});

test("同じ名前でも、別に宣言した port の provider では満たせない", () => {
  const other = port("newId").of<() => string>();
  expect(() => bind([items], { providers: [provide.value(other, "x"), provide.value(clock, 0)] })).toThrow(
    "missing providers for ports: newId",
  );
});

test("同じ port の provider と、同じ名前の rule の組は重ねて渡せない", () => {
  const providers = [provide.value(newId, "i"), provide.value(clock, 0)] as const;
  expect(() => bind([items], { providers: [...providers, provide.value(clock, 1)] })).toThrow(Panic);
  // @ts-expect-error 同じ名前の rule の組は型でも弾く
  expect(() => bind([items, items], { providers })).toThrow('bind: duplicate rule set name "item"');
});
