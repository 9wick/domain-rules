import { Result } from "@praha/byethrow";
import * as v from "valibot";
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

type Operator = { readonly name: string };
type Stored = { id: string; n: number };
type Input = { id?: string | undefined; n: number };

const operator: Operator = { name: "op" };
const item = defineModel<Operator>()({
  name: "item",
  schema: {
    input: v.object({ id: v.optional(v.string()), n: v.number() }),
    persisted: v.object({ id: v.string(), n: v.number() }),
  },
});
type LoadError = "DB_DOWN" | "MISSING";

// 1回の呼び出しごとに時刻を持つ呼び出しを作り、取得ステップが受け取った入力と actor を記録する
const contextWith = (find: (id: string) => Result.Result<Stored, LoadError>, now = 42) => {
  const load: Args<LoadInput<Input>, Operator>[] = [];
  const calls = { load, invocation: 0 };
  const loadItem: LoadRun<Input, Operator, Stored, LoadError> = {
    run: async (args) => (calls.load.push(args), find(args.input.id)),
  };
  const ctx: BindCtx = { invocation: () => (calls.invocation++, { scope: {}, now }) };
  return { ctx, calls, loadItem };
};

// 受け取った状態を記録し、next に id を付けて通す線路
const recordingSave = () => {
  const seen: SaveState<Stored | null, Input, Operator>[] = [];
  const rules: SaveRun<Stored, Input, Stored, Operator, Operator, "REJECTED"> = {
    run: async (s) => (
      seen.push(s),
      s.next.n < 0
        ? Result.fail("REJECTED")
        : Result.succeed({ next: { id: s.next.id ?? "new", n: s.next.n }, actor: s.actor })
    ),
  };
  return { rules, seen };
};

const stored: Stored = { id: "i1", n: 5 };

describe("create", () => {
  test("入力全体を検証し、線路が返した next と actor に封をする", async () => {
    const { ctx } = contextWith(() => Result.succeed(stored));
    const { rules, seen } = recordingSave();
    const r = await createMethod(item, rules)(ctx)({ input: { n: 1 }, actor: operator });
    expect(open(Result.unwrap(r))).toEqual({ pre: null, next: { id: "new", n: 1 }, actor: operator });
    expect(seen).toEqual([{ pre: null, next: { n: 1 }, input: { n: 1 }, actor: operator, now: 42 }]);
  });

  test("不正な入力は、呼び出しを作る前に input で失敗する", async () => {
    const { ctx, calls } = contextWith(() => Result.succeed(stored));
    const { rules, seen } = recordingSave();
    // @ts-expect-error 型に合わない入力を渡したときの実行時の振る舞いを確かめる
    const r = await createMethod(item, rules)(ctx)({ input: { n: "x" }, actor: operator });
    expect(Result.unwrapError(r)).toMatchObject({ step: "input" });
    expect([calls.invocation, seen.length]).toEqual([0, 0]);
  });

  test("線路の失敗はそのまま返す", async () => {
    const { ctx } = contextWith(() => Result.succeed(stored));
    const r = await createMethod(item, recordingSave().rules)(ctx)({ input: { n: -1 }, actor: operator });
    expect(Result.unwrapError(r)).toBe("REJECTED");
  });
});

describe("update", () => {
  test("既存の値に入力を重ねて next にし、pre と next を凍結した値に封をする", async () => {
    const fromDb = { ...stored };
    const { ctx, loadItem } = contextWith(() => Result.succeed(fromDb));
    const { rules, seen } = recordingSave();
    const r = await updateMethod(item, loadItem, rules)(ctx)({ input: { id: "i1", n: 9 }, actor: operator });
    const { pre, next } = open(Result.unwrap(r));
    expect([pre, next]).toEqual([stored, { id: "i1", n: 9 }]);
    expect([Object.isFrozen(pre), Object.isFrozen(next), Object.isFrozen(fromDb)]).toEqual([true, true, false]);
    expect(seen[0]?.pre).toEqual(stored);
  });

  test("取得ステップは検証した入力と actor を受け取る", async () => {
    const { ctx, calls, loadItem } = contextWith(() => Result.succeed(stored));
    await updateMethod(item, loadItem, recordingSave().rules)(ctx)({ input: { id: "i1", n: 9 }, actor: operator });
    expect(calls.load).toEqual([{ input: { id: "i1", n: 9 }, actor: operator }]);
  });

  test("線路の input は指定した項目だけを持ち、既存の値と同じ値でも指定したことが残る", async () => {
    const { ctx, loadItem } = contextWith(() => Result.succeed(stored));
    const { rules, seen } = recordingSave();
    const update = updateMethod(item, loadItem, rules)(ctx);
    await update({ input: { id: "i1" }, actor: operator });
    await update({ input: { id: "i1", n: stored.n }, actor: operator });
    expect(seen.map((s) => [s.input, s.next])).toEqual([
      [{ id: "i1" }, stored],
      [{ id: "i1", n: 5 }, stored],
    ]);
    expect(seen.every((s) => Object.isFrozen(s.input))).toBe(true);
  });

  test("入力にない項目は既存の値を残す", async () => {
    const { ctx, loadItem } = contextWith(() => Result.succeed(stored));
    const r = await updateMethod(item, loadItem, recordingSave().rules)(ctx)({ input: { id: "i1" }, actor: operator });
    expect(open(Result.unwrap(r)).next).toEqual(stored);
  });

  test("id がなければ input で失敗し、load を呼ばない", async () => {
    const { ctx, calls, loadItem } = contextWith(() => Result.succeed(stored));
    // @ts-expect-error id のない入力を、型を通さずに渡したときの実行時の振る舞いを確かめる
    const r = await updateMethod(item, loadItem, recordingSave().rules)(ctx)({ input: { n: 1 }, actor: operator });
    expect(Result.unwrapError(r)).toMatchObject({ step: "input", error: { issues: [{ path: ["id"] }] } });
    expect(calls.load).toEqual([]);
  });

  test("取得ステップの失敗は、そのまま load の失敗になる", async () => {
    const missing = contextWith(() => Result.fail("MISSING"));
    const update = updateMethod(item, missing.loadItem, recordingSave().rules);
    expect(Result.unwrapError(await update(missing.ctx)({ input: { id: "i9" }, actor: operator }))).toEqual({
      step: "load",
      error: "MISSING",
    });
  });

  test("load は入力スキーマで変換した id を受け取る", async () => {
    const numbered = defineModel<Operator>()({
      name: "numbered",
      schema: {
        input: v.object({ id: v.optional(v.union([v.number(), v.pipe(v.string(), v.transform(Number))])) }),
        persisted: v.object({ id: v.number() }),
      },
    });
    const find: LoadRun<{ id?: number | undefined }, Operator, { id: number }, never> = {
      run: async ({ input }) => Result.succeed({ id: input.id }),
    };
    const rules: SaveRun<{ id: number }, { id?: number | undefined }, { id: number }, Operator, Operator, never> = {
      run: async (s) => Result.succeed({ next: { id: s.next.id ?? 0 }, actor: s.actor }),
    };
    const r = await updateMethod(numbered, find, rules)({ invocation: () => ({ scope: {}, now: 0 }) })({
      input: { id: "42" },
      actor: operator,
    });
    expect(open(Result.unwrap(r)).pre.id).toBe(42);
  });
});

describe("項目をまたぐ検証", () => {
  type Range = { id: string; from: number; to: number };
  type RangeValue = { id?: string | undefined; from: number; to: number };
  const ranged = defineModel<Operator>()({
    name: "ranged",
    schema: {
      input: v.pipe(
        v.object({ id: v.optional(v.string()), from: v.number(), to: v.number() }),
        v.check((r) => r.from <= r.to, "from は to 以下"),
      ),
      persisted: v.object({ id: v.string(), from: v.number(), to: v.number() }),
    },
  });
  const existing: Range = { id: "r1", from: 1, to: 5 };
  const passThrough: SaveRun<Range, RangeValue, Range, Operator, Operator, never> = {
    run: async (s) =>
      Result.succeed({ next: { id: s.next.id ?? "new", from: s.next.from, to: s.next.to }, actor: s.actor }),
  };
  const setup = () => {
    const load: string[] = [];
    const find: LoadRun<RangeValue, Operator, Range, never> = {
      run: async ({ input }) => (load.push(input.id), Result.succeed(existing)),
    };
    const update = updateMethod(ranged, find, passThrough)({ invocation: () => ({ scope: {}, now: 0 }) });
    return { load, update };
  };

  test("create でも update でも、モデルの schema に書いた検証が効く", async () => {
    const create = createMethod(ranged, passThrough)({ invocation: () => ({ scope: {}, now: 0 }) });
    const created = await create({ input: { from: 9, to: 5 }, actor: operator });
    // 抜粋の from だけを変えても、既存の to と重ねた next で確かめる
    const updated = await setup().update({ input: { id: "r1", from: 9 }, actor: operator });
    expect([Result.unwrapError(created), Result.unwrapError(updated)]).toMatchObject([
      { step: "input", error: { issues: [{ message: "from は to 以下" }] } },
      { step: "input", error: { issues: [{ message: "from は to 以下" }] } },
    ]);
  });

  test("重ねた next が schema を満たせば、既存の値を引き継いで通る", async () => {
    const r = await setup().update({ input: { id: "r1", from: 3 }, actor: operator });
    expect(open(Result.unwrap(r)).next).toEqual({ id: "r1", from: 3, to: 5 });
  });

  test("項目単体で不正な抜粋は、既存の値を取得する前に失敗する", async () => {
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
    expect(open(Result.unwrap(await upsert({ input: { n: 1 }, actor: operator }))).pre).toBeNull();
    expect(open(Result.unwrap(await upsert({ input: { id: "i1", n: 2 }, actor: operator }))).pre).toEqual(stored);
    expect(calls.load.map((a) => a.input.id)).toEqual(["i1"]);
  });
});

// 受け取った状態を記録し、actor をそのまま通す削除の線路
const recordingDelete = () => {
  const seen: DeleteState<Stored, Input, Operator>[] = [];
  const rules: DeleteRun<Stored, Input, Operator, Operator, never> = {
    run: async (s) => (seen.push(s), Result.succeed({ actor: s.actor })),
  };
  return { rules, seen };
};

describe("delete", () => {
  test("既存の値を線路に渡し、線路が返した actor と pre に封をする", async () => {
    const { ctx, loadItem } = contextWith(() => Result.succeed(stored));
    const { rules, seen } = recordingDelete();
    const r = await deleteMethod(item, loadItem, rules)(ctx)({ input: { id: "i1" }, actor: operator });
    expect(open(Result.unwrap(r))).toEqual({ pre: stored, actor: operator });
    expect(seen).toEqual([{ pre: stored, next: null, input: { id: "i1" }, actor: operator, now: 42 }]);
  });

  test("id 以外の入力も、検証して取得ステップと線路の input に渡す", async () => {
    const { ctx, calls, loadItem } = contextWith(() => Result.succeed(stored));
    const { rules, seen } = recordingDelete();
    await deleteMethod(item, loadItem, rules)(ctx)({ input: { id: "i1", n: 5 }, actor: operator });
    expect(calls.load).toEqual([{ input: { id: "i1", n: 5 }, actor: operator }]);
    expect(seen.map((s) => s.input)).toEqual([{ id: "i1", n: 5 }]);
    expect(seen.every((s) => Object.isFrozen(s.input))).toBe(true);
  });

  test("項目単体で不正な入力は input で失敗し、load を呼ばない", async () => {
    const { ctx, calls, loadItem } = contextWith(() => Result.succeed(stored));
    const { rules, seen } = recordingDelete();
    // @ts-expect-error 型に合わない入力を渡したときの実行時の振る舞いを確かめる
    const r = await deleteMethod(item, loadItem, rules)(ctx)({ input: { id: "i1", n: "x" }, actor: operator });
    expect(Result.unwrapError(r)).toMatchObject({ step: "input" });
    expect([calls.load.length, seen.length]).toEqual([0, 0]);
  });
});
