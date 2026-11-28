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
import { modelRules, type ModelRules } from "./model-rules.ts";
import { Context } from "../port/provider.ts";
import { invocationOf } from "../port/invocation.ts";

type Operator = { readonly name: string };

const item = defineModel<Operator>()({
  name: "item",
  schema: {
    key: v.object({ id: v.optional(v.string()) }),
    value: v.object({ n: v.number() }),
    persisted: v.object({ id: v.string(), n: v.number() }),
  },
});
const findItem = port("findItem").of<(id: string) => { id: string; n: number }, "MISSING">();
const loaded = () =>
  modelRules(item).load({ requires: { findItem }, fetch: ({ input }, { findItem }) => findItem(input.id) });
const assignId = rule(item.onSave, {
  id: "assignId",
  description: "id を付ける",
  when: always,
  check: ({ pre }) => Result.succeed({ next: { id: pre?.id ?? "new" } }),
});
const save = ruleset(assignId);

test("メソッドの actor は domain の actor の型で、線路が昇格させた actor が封をした値に入る", async () => {
  const promote = rule(item.onSave, {
    id: "makeMember",
    description: "メンバーにする",
    when: always,
    check: ({ actor }) => Result.succeed({ actor: { ...actor, member: true as const } }),
  });
  const { update } = loaded()
    .save(ruleset(promote).add(assignId))
    .resolveIn({ invocation: () => invocationOf(new Context([]), 0) });
  expectTypeOf(update).parameter(0).toHaveProperty("actor").toEqualTypeOf<Operator>();
  const r = await update({ input: { id: "i1" }, actor: { name: "op" } });
  if (Result.isSuccess(r)) {
    expectTypeOf(open(r.value.persistable).actor).not.toBeNever();
    expectTypeOf(open(r.value.persistable).actor).toExtend<Operator & { readonly member: true }>();
  }
});

test("永続化の型にならない並びは型エラー", () => {
  const nothing = rule(item.onSave, {
    id: "noop",
    description: "何もしない",
    when: always,
    check: () => Result.succeed(),
  });
  // @ts-expect-error id を付けないと next.id が undefined のまま残る
  modelRules(item).save(ruleset(nothing));
});

test("fetch は検証した key と、domain の actor を受け取る。key の項目は id 以外も必須の型で届く", () => {
  const rental = defineModel<Operator>()({
    name: "rental",
    schema: {
      key: v.object({ id: v.optional(v.string()), tenantId: v.string() }),
      value: v.object({ n: v.number() }),
      persisted: v.object({ id: v.string(), tenantId: v.string(), n: v.number() }),
    },
  });
  const { update, delete: remove } = modelRules(rental)
    .load({
      fetch: ({ input, actor }) => {
        expectTypeOf(input).toEqualTypeOf<
          Readonly<{ id?: string | undefined; tenantId: string }> & { readonly id: string }
        >();
        expectTypeOf(actor).toEqualTypeOf<Operator>();
        return Result.succeed({ id: input.id, tenantId: input.tenantId, n: 0 });
      },
    })
    .save(
      ruleset(
        rule(rental.onSave, {
          id: "assignId",
          description: "id を付ける",
          when: always,
          check: ({ pre }) => Result.succeed({ next: { id: pre?.id ?? "new" } }),
        }),
      ),
    )
    .delete(ruleset(alwaysAllow))
    .resolveIn({ invocation: () => invocationOf(new Context([]), 0) });
  // @ts-expect-error tenantId は key なので、update でも省略できない
  void update({ input: { id: "r1", n: 1 }, actor: { name: "op" } });
  // value は変える項目だけを渡せる
  void update({ input: { id: "r1", tenantId: "t1" }, actor: { name: "op" } });
  // @ts-expect-error delete も key で対象を決める
  void remove({ input: { id: "r1" }, actor: { name: "op" } });
  // @ts-expect-error delete は value を受け取らない
  void remove({ input: { id: "r1", tenantId: "t1", n: 1 }, actor: { name: "op" } });
});

test("load の失敗は、fetch が返した失敗を load の失敗として持つ", async () => {
  const { update } = loaded()
    .save(save)
    .resolveIn({ invocation: () => invocationOf(new Context([]), 0) });
  const r = await update({ input: { id: "i1" }, actor: { name: "op" } });
  if (Result.isFailure(r) && r.error.step === "load") expectTypeOf(r.error.error).toEqualTypeOf<"MISSING">();
});

test("rule の組の port には、fetch の requires の port が入る", () => {
  expectTypeOf(loaded().save(save)).toExtend<ModelRules<"item", unknown, "findItem">>();
});

test("id のない model には load を書けない", () => {
  const noId = defineModel<Operator>()({
    name: "noId",
    schema: { key: v.object({}), value: v.object({ n: v.number() }), persisted: v.object({ n: v.number() }) },
  });
  // @ts-expect-error 更新と削除は id で対象を決めるので、key の schema に id が要る
  modelRules(noId).load({ fetch: () => Result.succeed({ n: 1 }) });
});

test("fetch の返り値は、モデルの値の型にも代入できなければならない", () => {
  const appointment = defineModel<Operator>()({
    name: "appointment",
    schema: {
      key: v.object({ id: v.optional(v.string()) }),
      value: v.object({ date: v.string() }),
      persisted: v.object({ id: v.string(), date: v.date() }),
    },
  });
  // @ts-expect-error 更新で date を省略すると、next の date に value の型ではない Date が入る
  modelRules(appointment).load({ fetch: ({ input }) => Result.succeed({ id: input.id, date: new Date() }) });
});

test("load の型を前提にする線路は、その型を返す load とだけ組める", () => {
  type Existing = { id: `i${string}`; n: number };
  const existingOnly = rule(item.onSave.assuming<{ pre: Existing | null }>(), {
    id: "existingId",
    description: "既存の id",
    when: always,
    check: () => Result.succeed(),
  });
  const withExisting = ruleset(existingOnly).add(assignId);
  const existing: Existing = { id: "i1", n: 1 };
  modelRules(item)
    .load({ fetch: () => Result.succeed(existing) })
    .save(withExisting);
  loaded()
    // @ts-expect-error 永続化の型を返す load では、pre が Existing にならない
    .save(withExisting);
});

test("同じメソッドを2回書くこと、load を save よりあとに書くこと、load なしの delete は型エラー", () => {
  // @ts-expect-error save は1回だけ書ける
  loaded().save(save).save(save);
  // @ts-expect-error delete は1回だけ書ける
  loaded().delete(ruleset(alwaysAllow)).delete(ruleset(alwaysAllow));
  expectTypeOf(modelRules(item).save(save)).not.toHaveProperty("load");
  expectTypeOf(modelRules(item)).not.toHaveProperty("delete");
});

test("あるかどうか分からない線路は、rule の組に渡せない", () => {
  const maybe = [save, undefined][Number(false)];
  // @ts-expect-error 渡したかどうかが型で決まらないと、メソッドがあるかも型で決まらない
  modelRules(item).save(maybe);
});

test("value の schema が自分の出力を受け付けないと、update を作る save は型エラー", () => {
  const stamped = defineModel<Operator>()({
    name: "stamped",
    schema: {
      key: v.object({ id: v.optional(v.string()) }),
      value: v.object({
        at: v.pipe(
          v.string(),
          v.transform((s) => new Date(s)),
        ),
      }),
      persisted: v.object({ id: v.string(), at: v.date() }),
    },
  });
  const findStamped = port("findStamped").of<(id: string) => { id: string; at: Date }>();
  const keepId = rule(stamped.onSave, {
    id: "id",
    description: "id",
    when: always,
    check: ({ pre }) => Result.succeed({ next: { id: pre?.id ?? "new" } }),
  });
  const withLoad = modelRules(stamped).load({
    requires: { findStamped },
    fetch: ({ input }, { findStamped }) => findStamped(input.id),
  });
  // @ts-expect-error 重ねた next の Date を、文字列だけを受け付ける schema に通せない
  withLoad.save(ruleset(keepId));
  // create だけなら next をもう一度通さないので書ける
  modelRules(stamped).save(ruleset(keepId));
  // delete だけでも書ける
  withLoad.delete(ruleset(alwaysAllow));
});
