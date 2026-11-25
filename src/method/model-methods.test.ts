import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { defineModel, type DeleteState, type SaveState } from "../definition/model.ts";
import { port } from "../port/port.ts";
import type { BindCtx } from "./context.ts";
import {
  createMethod,
  deleteMethod,
  updateMethod,
  upsertMethod,
  type DeleteRun,
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
const findItem = port("findItem").of<(id: string) => Stored | null, "DB_DOWN">();

// 1回の呼び出しごとに、findItem の実装と時刻を持つ scope を作る
const contextWith = (find: (id: string) => Result.Result<Stored | null, "DB_DOWN">, now = 42) => {
  const scope = {};
  const load: string[] = [];
  const calls = { load, invocation: 0 };
  findItem.provider((id) => (calls.load.push(id), find(id))).registerIn(scope);
  const ctx: BindCtx = { invocation: () => (calls.invocation++, { scope, now }) };
  return { ctx, calls };
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
    const { ctx } = contextWith(() => Result.succeed(null));
    const { rules, seen } = recordingSave();
    const r = await createMethod(item, rules)(ctx)({ input: { n: 1 }, actor: operator });
    expect(open(Result.unwrap(r))).toEqual({ pre: null, next: { id: "new", n: 1 }, actor: operator });
    expect(seen).toEqual([{ pre: null, next: { n: 1 }, actor: operator, now: 42 }]);
  });

  test("不正な入力は、呼び出しを作る前に input で失敗する", async () => {
    const { ctx, calls } = contextWith(() => Result.succeed(null));
    const { rules, seen } = recordingSave();
    // @ts-expect-error 型に合わない入力を渡したときの実行時の振る舞いを確かめる
    const r = await createMethod(item, rules)(ctx)({ input: { n: "x" }, actor: operator });
    expect(Result.unwrapError(r)).toMatchObject({ step: "input" });
    expect([calls.invocation, seen.length]).toEqual([0, 0]);
  });

  test("線路の失敗はそのまま返す", async () => {
    const { ctx } = contextWith(() => Result.succeed(null));
    const r = await createMethod(item, recordingSave().rules)(ctx)({ input: { n: -1 }, actor: operator });
    expect(Result.unwrapError(r)).toBe("REJECTED");
  });
});

describe("update", () => {
  test("既存の値に入力を重ねて next にし、pre と next を凍結した値に封をする", async () => {
    const fromDb = { ...stored };
    const { ctx, calls } = contextWith(() => Result.succeed(fromDb));
    const { rules, seen } = recordingSave();
    const r = await updateMethod(item, findItem, rules)(ctx)({ input: { id: "i1", n: 9 }, actor: operator });
    const { pre, next } = open(Result.unwrap(r));
    expect([pre, next]).toEqual([stored, { id: "i1", n: 9 }]);
    expect([Object.isFrozen(pre), Object.isFrozen(next), Object.isFrozen(fromDb)]).toEqual([true, true, false]);
    expect(seen[0]?.pre).toEqual(stored);
    expect(calls.load).toEqual(["i1"]);
  });

  test("入力にない項目は既存の値を残す", async () => {
    const { ctx } = contextWith(() => Result.succeed(stored));
    const r = await updateMethod(item, findItem, recordingSave().rules)(ctx)({ input: { id: "i1" }, actor: operator });
    expect(open(Result.unwrap(r)).next).toEqual(stored);
  });

  test("id がなければ input で失敗し、load を呼ばない", async () => {
    const { ctx, calls } = contextWith(() => Result.succeed(stored));
    // @ts-expect-error id のない入力を、型を通さずに渡したときの実行時の振る舞いを確かめる
    const r = await updateMethod(item, findItem, recordingSave().rules)(ctx)({ input: { n: 1 }, actor: operator });
    expect(Result.unwrapError(r)).toMatchObject({ step: "input", error: { issues: [{ path: ["id"] }] } });
    expect(calls.load).toEqual([]);
  });

  test("load の port の失敗は load の失敗、既存の値がなければ NOT_FOUND", async () => {
    const down = contextWith(() => Result.fail("DB_DOWN"));
    const update = updateMethod(item, findItem, recordingSave().rules);
    expect(Result.unwrapError(await update(down.ctx)({ input: { id: "i1" }, actor: operator }))).toEqual({
      step: "load",
      error: "DB_DOWN",
    });
    const missing = contextWith(() => Result.succeed(null));
    expect(Result.unwrapError(await update(missing.ctx)({ input: { id: "i9" }, actor: operator }))).toEqual({
      step: "load",
      error: "NOT_FOUND",
    });
  });

  test("load は入力スキーマで変換した id を受け取る", async () => {
    const numbered = defineModel<Operator>()({
      name: "numbered",
      schema: {
        input: v.object({ id: v.optional(v.pipe(v.string(), v.transform(Number))) }),
        persisted: v.object({ id: v.number() }),
      },
    });
    const find = port("findNumbered").of<(id: number) => { id: number }>();
    const scope = {};
    find.provider((id) => Result.succeed({ id })).registerIn(scope);
    const rules: SaveRun<{ id: number }, { id?: number | undefined }, { id: number }, Operator, Operator, never> = {
      run: async (s) => Result.succeed({ next: { id: s.next.id ?? 0 }, actor: s.actor }),
    };
    const r = await updateMethod(numbered, find, rules)({ invocation: () => ({ scope, now: 0 }) })({
      input: { id: "42" },
      actor: operator,
    });
    expect(open(Result.unwrap(r)).pre.id).toBe(42);
  });
});

describe("upsert", () => {
  test("id がなければ作成、あれば更新する", async () => {
    const { ctx, calls } = contextWith(() => Result.succeed(stored));
    const upsert = upsertMethod(item, findItem, recordingSave().rules)(ctx);
    expect(open(Result.unwrap(await upsert({ input: { n: 1 }, actor: operator }))).pre).toBeNull();
    expect(open(Result.unwrap(await upsert({ input: { id: "i1", n: 2 }, actor: operator }))).pre).toEqual(stored);
    expect(calls.load).toEqual(["i1"]);
  });
});

describe("delete", () => {
  test("既存の値を線路に渡し、線路が返した actor と pre に封をする", async () => {
    const { ctx } = contextWith(() => Result.succeed(stored));
    const seen: DeleteState<Stored, Operator>[] = [];
    const rules: DeleteRun<Stored, Operator, Operator, never> = {
      run: async (s) => (seen.push(s), Result.succeed({ actor: s.actor })),
    };
    const r = await deleteMethod(item, findItem, rules)(ctx)({ input: { id: "i1" }, actor: operator });
    expect(open(Result.unwrap(r))).toEqual({ pre: stored, actor: operator });
    expect(seen).toEqual([{ pre: stored, next: null, actor: operator, now: 42 }]);
  });
});
