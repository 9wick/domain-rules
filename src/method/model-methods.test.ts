import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { alwaysAllow, always, bind, clock, model, modelRules, open, port, provide, rule, ruleset } from "../index.ts";
import { findItem, item, itemDomain, itemRules, member, stored } from "../testing/fixtures.ts";

test("update は id がなければ input で失敗し、load を呼ばない", async () => {
  let loaded = false;
  const r = await itemDomain(() => ((loaded = true), Result.succeed(stored))).update({
    // @ts-expect-error id のない入力を、型を通さずに渡したときの実行時の振る舞いを確かめる
    input: { n: 1 },
    actor: member,
  });
  expect(Result.unwrapError(r)).toMatchObject({ step: "input", error: { issues: [{ path: ["id"] }] } });
  expect(loaded).toBe(false);
});

test("load の port の失敗は load の失敗になる", async () => {
  const r = await itemDomain(() => Result.fail("DB_DOWN")).update({ input: { id: "i1", n: 2 }, actor: member });
  expect(Result.unwrapError(r)).toEqual({ step: "load", error: "DB_DOWN" });
});

test("delete は既存の値がなければ load で失敗する", async () => {
  const r = await itemDomain(() => Result.succeed(null)).delete({ input: { id: "i9" }, actor: member });
  expect(Result.unwrapError(r)).toEqual({ step: "load", error: "NOT_FOUND" });
});

test("封をした値の pre と next は凍結され、provider が返した値は凍結しない", async () => {
  const fromDb = { ...stored };
  const r = await itemDomain(() => Result.succeed(fromDb)).update({ input: { id: "i1", n: 9 }, actor: member });
  const { pre, next } = open(Result.unwrap(r));
  expect(Object.isFrozen(pre)).toBe(true);
  expect(Object.isFrozen(next)).toBe(true);
  expect(Object.isFrozen(fromDb)).toBe(false);
  expect(next).toEqual({ id: "i1", n: 9 });
});

test("rule で昇格した actor が封をした値に入る", async () => {
  const promoted = { ...member, promoted: true };
  const promote = rule(item.onSave, {
    name: "promote",
    when: always,
    check: () => Result.succeed({ actor: promoted, next: { id: "x" } }),
  });
  const domain = bind([modelRules(item).save(ruleset(promote))], { providers: [provide.value(clock, 0)] });
  expect(open(Result.unwrap(await domain.item.create({ input: { n: 1 }, actor: member }))).actor).toBe(promoted);
});

test("不正な入力は時計を呼ぶ前に input で失敗する", async () => {
  const domain = bind([itemRules], {
    providers: [
      provide.value(findItem, stored),
      provide(clock, () => {
        throw new Error("clock unavailable");
      }),
    ],
  });
  // @ts-expect-error id のない入力を、型を通さずに渡したときの実行時の振る舞いを確かめる
  const result = await domain.item.update({ input: { n: 1 }, actor: member });
  expect(Result.unwrapError(result)).toMatchObject({ step: "input" });
});

test("load は入力スキーマで変換された id を受け取る", async () => {
  const transformed = model({
    name: "transformed",
    schema: {
      input: v.object({ id: v.optional(v.pipe(v.string(), v.transform(Number))) }),
      persisted: v.object({ id: v.number() }),
    },
  });
  const load = port("loadTransformed").of<(id: number) => { id: number }>();
  const wrongLoad = port("wrongLoad").of<(id: string) => { id: number }>();
  // @ts-expect-error load に渡る id は変換済みの number
  modelRules(transformed).load(wrongLoad).delete(ruleset(alwaysAllow));
  const domain = bind([modelRules(transformed).load(load).delete(ruleset(alwaysAllow))], {
    providers: [provide(load, (id) => Result.succeed({ id })), provide.value(clock, 0)],
  });
  const result = await domain.transformed.delete({ input: { id: "42" }, actor: member });
  expect(open(Result.unwrap(result)).pre.id).toBe(42);
});
