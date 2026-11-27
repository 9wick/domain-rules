import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { Panic } from "../shared/panic.ts";
import { invocationOf } from "./invocation.ts";
import { cached, port } from "./port.ts";
import { Context, type Provider } from "./provider.ts";

const invocationWith = (...providers: Provider[]) => invocationOf(new Context(providers), 0);

test("callIn は、呼び出しの Context にある実装を呼ぶ", async () => {
  const double = port("double").of<(n: number) => number, "NEGATIVE">();
  const inv = invocationWith(double.provider((n) => (n < 0 ? Result.fail("NEGATIVE") : Result.succeed(n * 2))));
  expect(double.providedIn(inv.context)).toBe(true);
  expect(await double.callIn(inv, [2])).toEqual(Result.succeed(4));
  expect(await double.callIn(inv, [-1])).toEqual(Result.fail("NEGATIVE"));
});

test("valued は固定の値を成功で返す", async () => {
  const answer = port("answer").of<() => number>();
  expect(await answer.callIn(invocationWith(answer.valued(42)), [])).toEqual(Result.succeed(42));
});

test("実装のない Context で呼ぶと Panic にする", async () => {
  const missing = port("missing").of<() => number>();
  await expect(missing.callIn(invocationWith(), [])).rejects.toThrow(Panic);
});

test("resolveIn は、1回の呼び出しに束ねた関数を返す", async () => {
  const double = port("double").of<(n: number) => number>();
  const inv = invocationWith(double.provider((n) => Result.succeed(n * 2)));
  expect(await double.resolveIn(inv)(3)).toEqual(Result.succeed(6));
});

test("cached の port は1回の呼び出しの中でだけ、同じ引数の結果を使い回す", async () => {
  const raw = port("lookup").of<(n: number) => number>();
  const lookup = cached(raw);
  const calls: number[] = [];
  const context = new Context([raw.provider((n) => (calls.push(n), Result.succeed(n)))]);
  const first = invocationOf(context, 0);
  await lookup.callIn(first, [1]);
  await lookup.callIn(first, [1]);
  await lookup.callIn(first, [2]);
  await lookup.callIn(invocationOf(context, 0), [1]);
  expect(calls).toEqual([1, 2, 1]);
});

test("同じ宣言から作った cached の port どうしは、1回の呼び出しの中で結果を使い回す", async () => {
  const raw = port("lookup").of<(n: number) => number>();
  const calls: number[] = [];
  const inv = invocationWith(raw.provider((n) => (calls.push(n), Result.succeed(n))));
  await cached(raw).callIn(inv, [1]);
  await cached(raw).callIn(inv, [1]);
  expect(calls).toEqual([1]);
});

test("cached でない port は、同じ呼び出しの中でも毎回実装を呼ぶ", async () => {
  const lookup = port("lookup").of<(n: number) => number>();
  const calls: number[] = [];
  const inv = invocationWith(lookup.provider((n) => (calls.push(n), Result.succeed(n))));
  await lookup.callIn(inv, [1]);
  await lookup.callIn(inv, [1]);
  expect(calls).toEqual([1, 1]);
});

test("cached の port は、元の宣言の provider で満たせる", async () => {
  const raw = port("raw").of<(n: number) => number>();
  const inv = invocationWith(raw.provider((n) => Result.succeed(n + 1)));
  const memoized = cached(raw);
  expect(memoized.providedIn(inv.context)).toBe(true);
  expect(await memoized.callIn(inv, [2])).toEqual(Result.succeed(3));
});

test("同じ名前でも、別に宣言した port の provider では満たせない", () => {
  const declared = port("lookup").of<(n: number) => number>();
  const other = port("lookup").of<(n: number) => number>();
  expect(declared.providedIn(new Context([other.valued(1)]))).toBe(false);
});

test("port は状態を持たず、凍結した宣言になる", () => {
  const p = port("p").of<() => number>();
  expect(Object.isFrozen(p)).toBe(true);
  expect(Object.isFrozen(cached(p))).toBe(true);
});
