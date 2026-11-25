import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { always, conditionalStep } from "./step.ts";

type S = { readonly n: number; readonly next: { readonly a: number; readonly b: number } };
const state: S = { n: 1, next: { a: 1, b: 2 } };

test("当たる step は check の成功の値を状態に重ね、next は項目ごとに重ねる", async () => {
  const step = conditionalStep((s: S) => s.n > 0);
  const r = await step(state, async () => Result.succeed({ checked: true, next: { b: 3 } }));
  expect(r).toEqual(Result.succeed({ n: 1, checked: true, next: { a: 1, b: 3 } }));
});

test("当たらない step は check を呼ばず、状態をそのまま返す", async () => {
  let called = false;
  const step = conditionalStep((s: S) => s.n < 0);
  const r = await step(state, async () => ((called = true), Result.succeed({ checked: true })));
  expect(r).toEqual(Result.succeed(state));
  expect(called).toBe(false);
});

test("check の失敗はそのまま返す", async () => {
  const step = conditionalStep((s: S) => s.n > 0);
  expect(await step(state, async () => Result.fail("NG"))).toEqual(Result.fail("NG"));
});

test("always は常に check を呼んで重ね、説明は always", async () => {
  expect(await always.step(state, async () => Result.succeed({ checked: true }))).toEqual(
    Result.succeed({ ...state, checked: true }),
  );
  expect(always(state)).toBe(true);
  expect(always.description).toEqual({ kind: "always" });
});

test("重ねても元の状態は変えない", async () => {
  await always.step(state, async () => Result.succeed({ next: { a: 9 } }));
  expect(state).toEqual({ n: 1, next: { a: 1, b: 2 } });
});
