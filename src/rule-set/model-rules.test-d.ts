import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expectTypeOf, test } from "vite-plus/test";
import { defineModel } from "../definition/model.ts";
import { open } from "../method/seal.ts";
import { alwaysAllow } from "../pipeline/builtin-rules.ts";
import { rule } from "../pipeline/rule.ts";
import { ruleset } from "../pipeline/ruleset.ts";
import { always } from "../pipeline/when/step.ts";
import { port } from "../port/port.ts";
import { modelRules } from "./model-rules.ts";

type Operator = { readonly name: string };

const item = defineModel<Operator>()({
  name: "item",
  schema: {
    input: v.object({ id: v.optional(v.string()), n: v.number() }),
    persisted: v.object({ id: v.string(), n: v.number() }),
  },
});
const findItem = port("findItem").of<(id: string) => { id: string; n: number } | null>();
const assignId = rule(item.onSave, {
  name: "id を付ける",
  when: always,
  check: ({ pre }) => Result.succeed({ next: { id: pre?.id ?? "new" } }),
});
const save = ruleset(assignId);

test("メソッドの actor は domain の actor の型で、線路が昇格させた actor が封をした値に入る", async () => {
  const promote = rule(item.onSave, {
    name: "メンバーにする",
    when: always,
    check: ({ actor }) => Result.succeed({ actor: { ...actor, member: true as const } }),
  });
  const { update } = modelRules(item)
    .load(findItem)
    .save(ruleset(promote).add(assignId))
    .resolveIn({ invocation: () => ({ scope: {}, now: 0 }) });
  expectTypeOf(update).parameter(0).toHaveProperty("actor").toEqualTypeOf<Operator>();
  const r = await update({ input: { id: "i1" }, actor: { name: "op" } });
  if (Result.isSuccess(r)) {
    expectTypeOf(open(r.value).actor).not.toBeNever();
    expectTypeOf(open(r.value).actor).toExtend<Operator & { readonly member: true }>();
  }
});

test("永続化の型にならない並びは型エラー", () => {
  const nothing = rule(item.onSave, { name: "何もしない", when: always, check: () => Result.succeed() });
  // @ts-expect-error id を付けないと next.id が undefined のまま残る
  modelRules(item).save(ruleset(nothing));
});

test("load の返り値は、入力の型にも代入できなければならない", () => {
  const appointment = defineModel<Operator>()({
    name: "appointment",
    schema: {
      input: v.object({ id: v.optional(v.string()), date: v.string() }),
      persisted: v.object({ id: v.string(), date: v.date() }),
    },
  });
  const find = port("findAppointment").of<(id: string) => { id: string; date: Date } | null>();
  // @ts-expect-error 更新で date を省略すると、next の date に入力の型ではない Date が入る
  modelRules(appointment).load(find);
});

test("load は検証した id を受け取れなければならない", () => {
  const narrow = port("findNarrow").of<(id: "fixed") => { id: string; n: number } | null>();
  // @ts-expect-error 検証した id は string で、"fixed" しか受け取らない load には渡せない
  modelRules(item).load(narrow);
  modelRules(item).load(port("findWide").of<(id: string | number) => { id: string; n: number } | null>());
});

test("load の型を前提にする線路は、その型を返す load とだけ組める", () => {
  type Existing = { id: `i${string}`; n: number };
  const existingOnly = rule(item.onSave.assuming<{ pre: Existing | null }>(), {
    name: "既存の id",
    when: always,
    check: () => Result.succeed(),
  });
  const withExisting = ruleset(existingOnly).add(assignId);
  modelRules(item).load(port("findExisting").of<(id: string) => Existing | null>()).save(withExisting);
  modelRules(item)
    .load(findItem)
    // @ts-expect-error 永続化の型を返す load では、pre が Existing にならない
    .save(withExisting);
});

test("同じメソッドを2回書くこと、load を save よりあとに書くこと、load なしの delete は型エラー", () => {
  // @ts-expect-error save は1回だけ書ける
  modelRules(item).load(findItem).save(save).save(save);
  // @ts-expect-error delete は1回だけ書ける
  modelRules(item).load(findItem).delete(ruleset(alwaysAllow)).delete(ruleset(alwaysAllow));
  expectTypeOf(modelRules(item).save(save)).not.toHaveProperty("load");
  expectTypeOf(modelRules(item)).not.toHaveProperty("delete");
});

test("あるかどうか分からない線路は、rule の組に渡せない", () => {
  const maybe = [save, undefined][Number(false)];
  // @ts-expect-error 渡したかどうかが型で決まらないと、メソッドがあるかも型で決まらない
  modelRules(item).save(maybe);
});
