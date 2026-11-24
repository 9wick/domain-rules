import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, expectTypeOf, test } from "vite-plus/test";
import {
  alwaysAllow,
  always,
  bind,
  cached,
  clock,
  model,
  modelRules,
  open,
  port,
  provide,
  plan,
  rule,
  ruleset,
} from "../src/index.ts";

const item = model({
  name: "item",
  schema: {
    input: v.object({ id: v.optional(v.string()), n: v.number() }),
    persisted: v.object({ id: v.string(), n: v.number() }),
  },
});
const lookup = cached(port("lookup").of<(n: number) => number>());
const uncachedLookup = port("uncachedLookup").of<(n: number) => number>();

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
  const domain = bind([modelRules(item).save(ruleset(twice("a")).add(twice("b")))], {
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
  const domain = bind([modelRules(item).save(ruleset(twice("a")))], {
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
  const domain = bind([modelRules(item).save(ruleset(boom))], { providers: [provide.value(clock, 0)] });
  await expect(
    domain.item.create({ input: { n: 1 }, actor: { id: "usr_1" as never, role: "MEMBER" } }),
  ).rejects.toThrow("bug");
});

test("check が port の失敗を catch して成功を返しても、port の失敗で止まる", async () => {
  const failing = port("failing").of<() => number, "DOWN">();
  const swallow = rule(item.save, {
    name: "swallow",
    requires: { failing },
    when: always,
    check: async (_, { failing }) => {
      await failing().catch(() => 0);
      return Result.succeed({ next: { id: "i" } });
    },
  });
  const domain = bind([modelRules(item).save(ruleset(swallow))], {
    providers: [provide(failing, () => Result.fail("DOWN" as const)), provide.value(clock, 0)],
  });
  const r = await domain.item.create({ input: { n: 1 }, actor: { id: "usr_1" as never, role: "MEMBER" } });
  expect(Result.unwrapError(r)).toEqual({ step: "swallow", error: "DOWN" });
});

test("prototype の名前の項目も schema にない項目として失敗する", async () => {
  const domain = bind([modelRules(item).save(ruleset(twice("a")))], {
    providers: [provide.value(lookup, 1), provide.value(uncachedLookup, 1), provide.value(clock, 0)],
  });
  const r = await domain.item.create({
    input: { n: "x", constructor: 1 } as never,
    actor: { id: "usr_1" as never, role: "MEMBER" },
  });
  expect(Result.unwrapError(r)).toMatchObject({
    step: "input",
    error: { issues: [{ path: ["constructor"] }, { path: [{ key: "n" }] }] },
  });
});

const member = { id: "usr_1" as never, role: "MEMBER" } as const;

const stored = { id: "i1", n: 5 };
const findItem = port("findItem").of<(id: string) => { id: string; n: number } | null, "DB_DOWN">();
const assignId = rule(item.save, {
  name: "id",
  when: always,
  check: ({ next }) => Result.succeed({ next: { id: next.id ?? "new" } }),
});
const seenNow = rule(item.save, {
  name: "now",
  when: always,
  check: ({ now }) => (now === 42 ? Result.succeed() : Result.fail("WRONG_NOW")),
});
const itemRules = modelRules(item).load(findItem).save(ruleset(seenNow).add(assignId)).delete(ruleset(alwaysAllow));
const itemDomain = (load: () => Result.Result<{ id: string; n: number } | null, "DB_DOWN">) =>
  bind([itemRules], { providers: [provide(findItem, load), provide.value(clock, 42)] }).item;

test("時計の provider の値が now として rule に渡る", async () => {
  const r = await itemDomain(() => Result.succeed(stored)).create({ input: { n: 1 }, actor: member });
  expect(open(Result.unwrap(r)).next).toEqual({ id: "new", n: 1 });
});

test("update は id がなければ input で失敗し、load を呼ばない", async () => {
  let loaded = false;
  const r = await itemDomain(() => ((loaded = true), Result.succeed(stored))).update({
    input: { n: 1 } as never,
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
  const promote = rule(item.save, {
    name: "promote",
    when: always,
    check: () => Result.succeed({ actor: promoted, next: { id: "x" } }),
  });
  const domain = bind([modelRules(item).save(ruleset(promote))], { providers: [provide.value(clock, 0)] });
  expect(open(Result.unwrap(await domain.item.create({ input: { n: 1 }, actor: member }))).actor).toBe(promoted);
});

test("when が当たらない rule は check を呼ばず、状態を変えない", async () => {
  let called = false;
  const never = rule(item.save, { name: "never", when: () => false, check: () => ((called = true), Result.fail("X")) });
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
  base.add(rule(item.save, { name: "other", when: always, check: () => Result.succeed() }));
  expect(plan(modelRules(item).save(base)).save?.map((r) => r.name)).toEqual(["id"]);
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
  const result = await domain.item.update({ input: { n: 1 } as never, actor: member });
  expect(Result.unwrapError(result)).toMatchObject({ step: "input" });
});

test("同名の別宣言の provider では port を満たせない", () => {
  const otherLookup = port("lookup").of<(n: number) => string>();
  const set = modelRules(item).save(ruleset(twice("a")));
  expect(() =>
    bind([set], {
      providers: [provide.value(otherLookup, "wrong"), provide.value(uncachedLookup, 1), provide.value(clock, 0)],
    }),
  ).toThrow("provider が足りない port: lookup");
});

test("cached は元の宣言の provider を使う", async () => {
  const raw = port("raw").of<(n: number) => number>();
  const cachedRaw = cached(raw);
  const read = rule(item.save, {
    name: "read",
    when: always,
    requires: { cachedRaw },
    check: async ({ next }, { cachedRaw }) => Result.succeed({ next: { id: String(await cachedRaw(next.n)) } }),
  });
  const domain = bind([modelRules(item).save(ruleset(read))], {
    providers: [provide(raw, (n) => Result.succeed(n + 1)), provide.value(clock, 0)],
  });
  const result = await domain.item.create({ input: { n: 2 }, actor: member });
  expect(open(Result.unwrap(result)).next.id).toBe("3");
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

test("load の返り値は、入力の型にも代入できなければならない", () => {
  const appointment = model({
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
  const item = model({
    name: "item",
    schema: { input: v.object({ id: v.optional(v.string()) }), persisted: v.object({ id: v.string() }) },
  });
  const narrow = port("findNarrow").of<(id: "fixed") => { id: string } | null>();
  // @ts-expect-error 検証した id は string で、"fixed" しか受け取らない load には渡せない
  modelRules(item).load(narrow);
  modelRules(item).load(port("findWide").of<(id: string | number) => { id: string } | null>());
});

test("model の入力スキーマは id を必須にできない", () => {
  const schema = { input: v.object({ id: v.string() }), persisted: v.object({ id: v.string() }) };
  // @ts-expect-error create は入力から id を受け取らない
  model({ name: "requiredId", schema });
});

test("同じメソッドを2回書くことと、load を save よりあとに書くことは型エラー", () => {
  const save = ruleset(twice("a"));
  // @ts-expect-error save は1回だけ書ける
  modelRules(item).load(findItem).save(save).save(save);
  // @ts-expect-error delete は1回だけ書ける
  modelRules(item).load(findItem).delete(ruleset(alwaysAllow)).delete(ruleset(alwaysAllow));
  expectTypeOf(modelRules(item).save(save)).not.toHaveProperty("load");
});

test("bind には、長さの決まった rule の組の tuple だけを渡せる", () => {
  const sets = [modelRules(item).save(ruleset(twice("a")))];
  const providers = [provide.value(lookup, 1), provide.value(uncachedLookup, 1), provide.value(clock, 0)] as const;
  // @ts-expect-error 配列は要素が無いことがあり、型にあるメソッドが値に無いことがある
  expect(() => bind(sets, { providers })).not.toThrow();
});

test("あるかどうか分からない線路は、rule の組に渡せない", () => {
  const save = ruleset(twice("a"));
  const maybe = [save, undefined][Number(false)];
  // @ts-expect-error 渡したかどうかが型で決まらないと、メソッドがあるかも型で決まらない
  modelRules(item).save(maybe);
  modelRules(item).save(save);
});
