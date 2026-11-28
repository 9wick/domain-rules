import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { z } from "zod";
import { describe, expect, test } from "vite-plus/test";
import { defineModel, type DeleteState, type SaveState } from "../definition/model.ts";
import type { Args, BindCtx } from "./context.ts";
import {
  createMethod,
  deleteMethod,
  updateMethod,
  upsertMethod,
  type DeleteRun,
  type LoadInput,
  type LoadRun,
  type SaveRun,
} from "./model-methods.ts";
import { open } from "./seal.ts";
import { Context } from "../port/provider.ts";
import { invocationOf } from "../port/invocation.ts";

type Operator = { readonly name: string };
type Stored = { id: string; tenantId: string; n: number };
type Key = { id?: string | undefined; tenantId: string };
type Item = Key & { n: number };

const operator: Operator = { name: "op" };
// tenantId は id と同じく、モデルを特定する key の項目
const item = defineModel<Operator>()({
  name: "item",
  schema: {
    key: v.object({ id: v.optional(v.string()), tenantId: v.string() }),
    value: v.object({ n: v.number() }),
    persisted: v.object({ id: v.string(), tenantId: v.string(), n: v.number() }),
  },
});
type LoadError = "DB_DOWN" | "MISSING";

// 1回の呼び出しごとに時刻を持つ呼び出しを作り、取得ステップが受け取った key と actor を記録する
const contextWith = (find: (id: string) => Result.Result<Stored, LoadError>, now = 42) => {
  const load: Args<LoadInput<Key>, Operator>[] = [];
  const calls = { load, invocation: 0 };
  const loadItem: LoadRun<Key, Operator, Stored, LoadError> = {
    run: async (args) => (calls.load.push(args), find(args.input.id)),
  };
  const ctx: BindCtx = { invocation: () => (calls.invocation++, invocationOf(new Context([]), now)) };
  return { ctx, calls, loadItem };
};

// 受け取った状態を記録し、next に id を付けて通す線路
const recordingSave = () => {
  const seen: SaveState<Stored | null, Item, Operator>[] = [];
  const rules: SaveRun<Stored, Item, Stored, Operator, Operator, "REJECTED", never> = {
    run: async (s) => (
      seen.push(s),
      s.next.n < 0
        ? Result.fail("REJECTED")
        : Result.succeed({ state: { next: { ...s.next, id: s.next.id ?? "new" }, actor: s.actor }, events: [] })
    ),
  };
  return { rules, seen };
};

const stored: Stored = { id: "i1", tenantId: "t1", n: 5 };

describe("create", () => {
  test("key と value の全体を検証し、線路が返した next と actor に封をする", async () => {
    const { ctx } = contextWith(() => Result.succeed(stored));
    const { rules, seen } = recordingSave();
    const r = await createMethod(item, rules)(ctx)({ input: { tenantId: "t1", n: 1 }, actor: operator });
    expect(open(Result.unwrap(r).persistable)).toEqual({
      pre: null,
      next: { id: "new", tenantId: "t1", n: 1 },
      actor: operator,
    });
    expect(seen).toEqual([
      { pre: null, next: { tenantId: "t1", n: 1 }, input: { tenantId: "t1", n: 1 }, actor: operator, now: 42 },
    ]);
  });

  test("不正な入力は、呼び出しを作る前に input で失敗する。key と value の問題はまとめて返す", async () => {
    const { ctx, calls } = contextWith(() => Result.succeed(stored));
    const { rules, seen } = recordingSave();
    // @ts-expect-error 型に合わない入力を渡したときの実行時の振る舞いを確かめる
    const r = await createMethod(item, rules)(ctx)({ input: { n: "x" }, actor: operator });
    expect(Result.unwrapError(r)).toMatchObject({
      step: "input",
      error: { issues: [{ path: [{ key: "tenantId" }] }, { path: [{ key: "n" }] }] },
    });
    expect([calls.invocation, seen.length]).toEqual([0, 0]);
  });

  test("id と schema にない項目は受け付けない", async () => {
    const { ctx } = contextWith(() => Result.succeed(stored));
    const create = createMethod(item, recordingSave().rules)(ctx);
    // @ts-expect-error create は id を受け取らない
    const r = await create({ input: { id: "i1", tenantId: "t1", n: 1, extra: 1 }, actor: operator });
    expect(Result.unwrapError(r)).toMatchObject({
      step: "input",
      error: { issues: [{ path: ["id"] }, { path: ["extra"] }] },
    });
  });

  test("線路の失敗はそのまま返す", async () => {
    const { ctx } = contextWith(() => Result.succeed(stored));
    const r = await createMethod(item, recordingSave().rules)(ctx)({
      input: { tenantId: "t1", n: -1 },
      actor: operator,
    });
    expect(Result.unwrapError(r)).toBe("REJECTED");
  });
});

describe("update", () => {
  test("既存の値に差分を重ねて next にし、pre と next を凍結した値に封をする", async () => {
    const fromDb = { ...stored };
    const { ctx, loadItem } = contextWith(() => Result.succeed(fromDb));
    const { rules, seen } = recordingSave();
    const r = await updateMethod(item, loadItem, rules)(ctx)({
      input: { id: "i1", tenantId: "t1", n: 9 },
      actor: operator,
    });
    const { pre, next } = open(Result.unwrap(r).persistable);
    expect([pre, next]).toEqual([stored, { ...stored, n: 9 }]);
    expect([Object.isFrozen(pre), Object.isFrozen(next), Object.isFrozen(fromDb)]).toEqual([true, true, false]);
    expect(seen[0]?.pre).toEqual(stored);
  });

  test("取得ステップは検証した key と actor を受け取る。value の差分は渡さない", async () => {
    const { ctx, calls, loadItem } = contextWith(() => Result.succeed(stored));
    const update = updateMethod(item, loadItem, recordingSave().rules)(ctx);
    await update({ input: { id: "i1", tenantId: "t1", n: 9 }, actor: operator });
    expect(calls.load).toEqual([{ input: { id: "i1", tenantId: "t1" }, actor: operator }]);
  });

  test("線路の input は key と指定した value の項目だけを持ち、既存の値と同じ値でも指定したことが残る", async () => {
    const { ctx, loadItem } = contextWith(() => Result.succeed(stored));
    const { rules, seen } = recordingSave();
    const update = updateMethod(item, loadItem, rules)(ctx);
    await update({ input: { id: "i1", tenantId: "t1" }, actor: operator });
    await update({ input: { id: "i1", tenantId: "t1", n: stored.n }, actor: operator });
    expect(seen.map((s) => [s.input, s.next])).toEqual([
      [{ id: "i1", tenantId: "t1" }, stored],
      [{ id: "i1", tenantId: "t1", n: 5 }, stored],
    ]);
    expect(seen.every((s) => Object.isFrozen(s.input))).toBe(true);
  });

  test("key の項目がなければ input で失敗し、load を呼ばない", async () => {
    const { ctx, calls, loadItem } = contextWith(() => Result.succeed(stored));
    const update = updateMethod(item, loadItem, recordingSave().rules)(ctx);
    // @ts-expect-error key の項目のない入力を、型を通さずに渡したときの実行時の振る舞いを確かめる
    const r = await update({ input: { id: "i1", n: 1 }, actor: operator });
    expect(Result.unwrapError(r)).toMatchObject({
      step: "input",
      error: { issues: [{ path: [{ key: "tenantId" }] }] },
    });
    expect(calls.load).toEqual([]);
  });

  test("id がなければ input で失敗し、load を呼ばない", async () => {
    const { ctx, calls, loadItem } = contextWith(() => Result.succeed(stored));
    const update = updateMethod(item, loadItem, recordingSave().rules)(ctx);
    // @ts-expect-error id のない入力を、型を通さずに渡したときの実行時の振る舞いを確かめる
    const r = await update({ input: { tenantId: "t1", n: 1 }, actor: operator });
    expect(Result.unwrapError(r)).toMatchObject({ step: "input", error: { issues: [{ path: ["id"] }] } });
    expect(calls.load).toEqual([]);
  });

  test("取得ステップの失敗は、そのまま load の失敗になる", async () => {
    const missing = contextWith(() => Result.fail("MISSING"));
    const update = updateMethod(item, missing.loadItem, recordingSave().rules)(missing.ctx);
    expect(Result.unwrapError(await update({ input: { id: "i9", tenantId: "t1" }, actor: operator }))).toEqual({
      step: "load",
      error: "MISSING",
    });
  });

  test("load は key の schema で変換した id を受け取る", async () => {
    const numbered = defineModel<Operator>()({
      name: "numbered",
      schema: {
        key: v.object({ id: v.optional(v.union([v.number(), v.pipe(v.string(), v.transform(Number))])) }),
        value: v.object({}),
        persisted: v.object({ id: v.number() }),
      },
    });
    const find: LoadRun<{ id?: number | undefined }, Operator, { id: number }, never> = {
      run: async ({ input }) => Result.succeed({ id: input.id }),
    };
    const rules: SaveRun<
      { id: number },
      { id?: number | undefined },
      { id: number },
      Operator,
      Operator,
      never,
      never
    > = {
      run: async (s) => Result.succeed({ state: { next: { id: s.next.id ?? 0 }, actor: s.actor }, events: [] }),
    };
    const r = await updateMethod(numbered, find, rules)({ invocation: () => invocationOf(new Context([]), 0) })({
      input: { id: "42" },
      actor: operator,
    });
    expect(open(Result.unwrap(r).persistable).pre.id).toBe(42);
  });
});

describe("項目をまたぐ検証", () => {
  type Range = { id: string; from: number; to: number };
  type RangeValue = { id?: string | undefined } & { from: number; to: number };
  const ranged = defineModel<Operator>()({
    name: "ranged",
    schema: {
      key: v.object({ id: v.optional(v.string()) }),
      value: v.pipe(
        v.object({ from: v.number(), to: v.number() }),
        v.check((r) => r.from <= r.to, "from は to 以下"),
      ),
      persisted: v.object({ id: v.string(), from: v.number(), to: v.number() }),
    },
  });
  const existing: Range = { id: "r1", from: 1, to: 5 };
  const passThrough: SaveRun<Range, RangeValue, Range, Operator, Operator, never, never> = {
    run: async (s) =>
      Result.succeed({ state: { next: { ...s.next, id: s.next.id ?? "new" }, actor: s.actor }, events: [] }),
  };
  const setup = () => {
    const load: string[] = [];
    const find: LoadRun<{ id?: string | undefined }, Operator, Range, never> = {
      run: async ({ input }) => (load.push(input.id), Result.succeed(existing)),
    };
    const update = updateMethod(ranged, find, passThrough)({ invocation: () => invocationOf(new Context([]), 0) });
    return { load, update };
  };

  test("create でも update でも、value の schema に書いた検証が効く", async () => {
    const create = createMethod(ranged, passThrough)({ invocation: () => invocationOf(new Context([]), 0) });
    const created = await create({ input: { from: 9, to: 5 }, actor: operator });
    // 差分の from だけを変えても、既存の to と重ねた値で確かめる
    const updated = await setup().update({ input: { id: "r1", from: 9 }, actor: operator });
    expect([Result.unwrapError(created), Result.unwrapError(updated)]).toMatchObject([
      { step: "input", error: { issues: [{ message: "from は to 以下" }] } },
      { step: "input", error: { issues: [{ message: "from は to 以下" }] } },
    ]);
  });

  test("重ねた値が schema を満たせば、既存の値を引き継いで通る", async () => {
    const r = await setup().update({ input: { id: "r1", from: 3 }, actor: operator });
    expect(open(Result.unwrap(r).persistable).next).toEqual({ id: "r1", from: 3, to: 5 });
  });

  test("項目単体で不正な差分は、既存の値を取得する前に失敗する", async () => {
    const { load, update } = setup();
    // @ts-expect-error 型に合わない入力を渡したときの実行時の振る舞いを確かめる
    const r = await update({ input: { id: "r1", from: "x" }, actor: operator });
    expect(Result.unwrapError(r)).toMatchObject({ step: "input", error: { issues: [{ path: ["from"] }] } });
    expect(load).toEqual([]);
  });
});

describe("upsert", () => {
  test("id がなければ作成、あれば更新する", async () => {
    const { ctx, calls, loadItem } = contextWith(() => Result.succeed(stored));
    const upsert = upsertMethod(item, loadItem, recordingSave().rules)(ctx);
    expect(
      open(Result.unwrap(await upsert({ input: { tenantId: "t1", n: 1 }, actor: operator })).persistable).pre,
    ).toBeNull();
    expect(
      open(Result.unwrap(await upsert({ input: { id: "i1", tenantId: "t1", n: 2 }, actor: operator })).persistable).pre,
    ).toEqual(stored);
    expect(calls.load.map((a) => a.input.id)).toEqual(["i1"]);
  });
});

// 受け取った状態を記録し、actor をそのまま通す削除の線路
const recordingDelete = () => {
  const seen: DeleteState<Stored, Key, Operator>[] = [];
  const rules: DeleteRun<Stored, Key, Operator, Operator, never, never> = {
    run: async (s) => (seen.push(s), Result.succeed({ state: { actor: s.actor }, events: [] })),
  };
  return { rules, seen };
};

describe("delete", () => {
  test("key で取得した既存の値を線路に渡し、線路が返した actor と pre に封をする", async () => {
    const { ctx, calls, loadItem } = contextWith(() => Result.succeed(stored));
    const { rules, seen } = recordingDelete();
    const r = await deleteMethod(item, loadItem, rules)(ctx)({ input: { id: "i1", tenantId: "t1" }, actor: operator });
    expect(open(Result.unwrap(r).deletable)).toEqual({ pre: stored, actor: operator });
    expect(calls.load).toEqual([{ input: { id: "i1", tenantId: "t1" }, actor: operator }]);
    expect(seen).toEqual([{ pre: stored, next: null, input: { id: "i1", tenantId: "t1" }, actor: operator, now: 42 }]);
    expect(seen.every((s) => Object.isFrozen(s.input))).toBe(true);
  });

  test("value の項目や不正な key は input で失敗し、load を呼ばない", async () => {
    const { ctx, calls, loadItem } = contextWith(() => Result.succeed(stored));
    const { rules, seen } = recordingDelete();
    const remove = deleteMethod(item, loadItem, rules)(ctx);
    // @ts-expect-error delete は value を受け取らない
    const withValue = await remove({ input: { id: "i1", tenantId: "t1", n: 5 }, actor: operator });
    // @ts-expect-error 型に合わない key を渡したときの実行時の振る舞いを確かめる
    const badKey = await remove({ input: { id: "i1", tenantId: 1 }, actor: operator });
    expect([Result.unwrapError(withValue), Result.unwrapError(badKey)]).toMatchObject([
      { step: "input", error: { issues: [{ path: ["n"] }] } },
      { step: "input", error: { issues: [{ path: [{ key: "tenantId" }] }] } },
    ]);
    expect([calls.load.length, seen.length]).toEqual([0, 0]);
  });
});

describe("Zod の schema", () => {
  type Range = { id: string; from: number; to: number };
  type RangeValue = { id?: string | undefined } & { from: number; to: number };
  const ranged = defineModel<Operator>()({
    name: "ranged",
    schema: {
      key: z.object({ id: z.string().optional() }),
      value: z.object({ from: z.number(), to: z.number() }).refine((r) => r.from <= r.to, "from は to 以下"),
      persisted: z.object({ id: z.string(), from: z.number(), to: z.number() }),
    },
  });
  const existing: Range = { id: "r1", from: 1, to: 5 };
  const passThrough: SaveRun<Range, RangeValue, Range, Operator, Operator, never, never> = {
    run: async (s) =>
      Result.succeed({ state: { next: { ...s.next, id: s.next.id ?? "new" }, actor: s.actor }, events: [] }),
  };
  const ctx: BindCtx = { invocation: () => invocationOf(new Context([]), 0) };
  const find: LoadRun<{ id?: string | undefined }, Operator, Range, never> = {
    run: async () => Result.succeed(existing),
  };

  test("create は shape の項目で入力を分け、schema にない項目は受け付けない", async () => {
    const create = createMethod(ranged, passThrough)(ctx);
    const created = await create({ input: { from: 1, to: 2 }, actor: operator });
    // @ts-expect-error schema にない項目を渡したときの実行時の振る舞いを確かめる
    const extra = await create({ input: { from: 1, to: 2, extra: 1 }, actor: operator });
    expect(open(Result.unwrap(created).persistable).next).toEqual({ id: "new", from: 1, to: 2 });
    expect(Result.unwrapError(extra)).toMatchObject({ step: "input", error: { issues: [{ path: ["extra"] }] } });
  });

  test("update は差分の項目を shape の項目の schema で検証し、既存の値と重ねた値に refine をかける", async () => {
    const update = updateMethod(ranged, find, passThrough)(ctx);
    const passed = await update({ input: { id: "r1", from: 3 }, actor: operator });
    // @ts-expect-error 型に合わない入力を渡したときの実行時の振る舞いを確かめる
    const badField = await update({ input: { id: "r1", from: "x" }, actor: operator });
    const crossed = await update({ input: { id: "r1", from: 9 }, actor: operator });
    expect(open(Result.unwrap(passed).persistable).next).toEqual({ id: "r1", from: 3, to: 5 });
    expect([Result.unwrapError(badField), Result.unwrapError(crossed)]).toMatchObject([
      { step: "input", error: { issues: [{ path: ["from"] }] } },
      { step: "input", error: { issues: [{ message: "from は to 以下" }] } },
    ]);
  });
});
