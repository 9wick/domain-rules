import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { Panic } from "../shared/panic.ts";
import type { Invocation } from "./invocation.ts";
import { cached, port } from "./port.ts";

const invocationIn = (scope: object): Invocation => ({ scope, now: 0 });

test("callIn は、呼び出しの scope に登録した実装を呼ぶ", async () => {
  const double = port("double").of<(n: number) => number, "NEGATIVE">();
  const scope = {};
  double.provider((n) => (n < 0 ? Result.fail("NEGATIVE") : Result.succeed(n * 2))).registerIn(scope);
  expect(double.providedIn(scope)).toBe(true);
  expect(await double.callIn(invocationIn(scope), [2])).toEqual(Result.succeed(4));
  expect(await double.callIn(invocationIn(scope), [-1])).toEqual(Result.fail("NEGATIVE"));
});

test("valued は固定の値を成功で返す", async () => {
  const answer = port("answer").of<() => number>();
  const scope = {};
  answer.valued(42).registerIn(scope);
  expect(await answer.callIn(invocationIn(scope), [])).toEqual(Result.succeed(42));
});

test("実装を登録していない scope で呼ぶと Panic にする", async () => {
  const missing = port("missing").of<() => number>();
  await expect(missing.callIn(invocationIn({}), [])).rejects.toThrow(Panic);
});

test("resolveIn は、1回の呼び出しに束ねた関数を返す", async () => {
  const double = port("double").of<(n: number) => number>();
  const scope = {};
  double.provider((n) => Result.succeed(n * 2)).registerIn(scope);
  expect(await double.resolveIn(invocationIn(scope))(3)).toEqual(Result.succeed(6));
});

test("cached の port は1回の呼び出しの中でだけ、同じ引数の結果を使い回す", async () => {
  const raw = port("lookup").of<(n: number) => number>();
  const lookup = cached(raw);
  const calls: number[] = [];
  const scope = {};
  raw.provider((n) => (calls.push(n), Result.succeed(n))).registerIn(scope);
  const first = invocationIn(scope);
  await lookup.callIn(first, [1]);
  await lookup.callIn(first, [1]);
  await lookup.callIn(first, [2]);
  await lookup.callIn(invocationIn(scope), [1]);
  expect(calls).toEqual([1, 2, 1]);
});

test("cached でない port は、同じ呼び出しの中でも毎回実装を呼ぶ", async () => {
  const lookup = port("lookup").of<(n: number) => number>();
  const calls: number[] = [];
  const scope = {};
  lookup.provider((n) => (calls.push(n), Result.succeed(n))).registerIn(scope);
  const inv = invocationIn(scope);
  await lookup.callIn(inv, [1]);
  await lookup.callIn(inv, [1]);
  expect(calls).toEqual([1, 1]);
});

test("cached の port は、元の宣言の provider で満たせる", async () => {
  const raw = port("raw").of<(n: number) => number>();
  const scope = {};
  raw.provider((n) => Result.succeed(n + 1)).registerIn(scope);
  const memoized = cached(raw);
  expect(memoized.providedIn(scope)).toBe(true);
  expect(await memoized.callIn(invocationIn(scope), [2])).toEqual(Result.succeed(3));
});

test("同じ名前でも、別に宣言した port の provider では満たせない", () => {
  const declared = port("lookup").of<(n: number) => number>();
  const other = port("lookup").of<(n: number) => number>();
  const scope = {};
  other.valued(1).registerIn(scope);
  expect(declared.providedIn(scope)).toBe(false);
});
