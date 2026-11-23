import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { always, bind, cached, clock, model, modelRules, open, port, provide, rule } from "../src/index.ts";

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
  const domain = bind([modelRules(item, { save: [swallow] })], {
    providers: [provide(failing, () => Result.fail("DOWN" as const)), provide.value(clock, 0)],
  });
  const r = await domain.item.create({ input: { n: 1 }, actor: { id: "usr_1" as never, role: "MEMBER" } });
  expect(Result.unwrapError(r)).toEqual({ step: "swallow", error: "DOWN" });
});

test("prototype の名前の項目も schema にない項目として失敗する", async () => {
  const domain = bind([modelRules(item, { save: [twice("a")] })], {
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
const itemRules = modelRules(item, { load: findItem, save: [seenNow, assignId], delete: [] });
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
  const domain = bind([modelRules(item, { save: [promote] })], { providers: [provide.value(clock, 0)] });
  expect(open(Result.unwrap(await domain.item.create({ input: { n: 1 }, actor: member }))).actor).toBe(promoted);
});

test("when が当たらない rule は check を呼ばず、状態を変えない", async () => {
  let called = false;
  const never = rule(item.save, { name: "never", when: () => false, check: () => ((called = true), Result.fail("X")) });
  const domain = bind([modelRules(item, { save: [never, assignId] })], { providers: [provide.value(clock, 0)] });
  expect(open(Result.unwrap(await domain.item.create({ input: { n: 1 }, actor: member }))).next).toEqual({
    id: "new",
    n: 1,
  });
  expect(called).toBe(false);
});

test("宣言後に元の配列を変更しても、検査済みの rule が実行される", async () => {
  const save: [typeof assignId] = [assignId];
  const set = modelRules(item, { save });
  save.pop();
  const domain = bind([set], { providers: [provide.value(clock, 0)] });
  const result = await domain.item.create({ input: { n: 1 }, actor: member });
  expect(open(Result.unwrap(result)).next).toEqual({ id: "new", n: 1 });
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
  const set = modelRules(item, { save: [twice("a")] });
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
  const domain = bind([modelRules(item, { save: [read] })], {
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
  modelRules(transformed, { load: wrongLoad, delete: [] });
  const domain = bind([modelRules(transformed, { load, delete: [] })], {
    providers: [provide(load, (id) => Result.succeed({ id })), provide.value(clock, 0)],
  });
  const result = await domain.transformed.delete({ input: { id: "42" }, actor: member });
  expect(open(Result.unwrap(result)).pre.id).toBe(42);
});

test("save は更新で引き継いだ永続化済みの値と検証済みの入力を扱える", async () => {
  const appointment = model({
    name: "appointment",
    schema: {
      input: v.object({ id: v.optional(v.string()), date: v.string() }),
      persisted: v.object({ id: v.string(), date: v.date() }),
    },
  });
  const date = new Date("2026-11-24");
  const find = port("findAppointment").of<(id: string) => { id: string; date: Date }>();
  const stringOnly = rule(appointment.save.with<{ next: { date: string } }>(), {
    name: "stringOnly",
    when: always,
    check: ({ next }) => Result.succeed({ next: { id: "new", date: new Date(next.date) } }),
  });
  // @ts-expect-error 更新で date を省略すると、永続化済みの Date が渡る
  modelRules(appointment, { load: find, save: [stringOnly] });
  modelRules(appointment, { save: [stringOnly] });

  const normalize = rule(appointment.save, {
    name: "normalize",
    when: always,
    check: ({ next }) =>
      Result.succeed({
        next: { id: next.id ?? "new", date: typeof next.date === "string" ? new Date(next.date) : next.date },
      }),
  });
  const domain = bind([modelRules(appointment, { load: find, save: [normalize] })], {
    providers: [provide(find, (id) => Result.succeed({ id, date })), provide.value(clock, 0)],
  });
  const created = await domain.appointment.create({ input: { date: "2026-11-24" }, actor: member });
  const updated = await domain.appointment.update({ input: { id: "existing" }, actor: member });
  expect(open(Result.unwrap(created)).next.date).toEqual(date);
  expect(open(Result.unwrap(updated)).next.date).toBe(date);
});

test("model の入力スキーマは id を必須にできない", () => {
  const schema = { input: v.object({ id: v.string() }), persisted: v.object({ id: v.string() }) };
  // @ts-expect-error create は入力から id を受け取らない
  model({ name: "requiredId", schema });
});
