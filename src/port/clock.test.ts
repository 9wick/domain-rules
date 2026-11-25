import { expect, test } from "vite-plus/test";
import { Panic } from "../shared/panic.ts";
import { clock } from "./clock.ts";

test("登録した scope でだけ、provider の時刻を返す", () => {
  const scope = {};
  expect(clock.providedIn(scope)).toBe(false);
  expect(clock.nowIn(scope)).toBeUndefined();
  let now = 1;
  clock.provider(() => now++).registerIn(scope);
  expect(clock.providedIn(scope)).toBe(true);
  expect([clock.nowIn(scope), clock.nowIn(scope)]).toEqual([1, 2]);
  expect(clock.nowIn({})).toBeUndefined();
});

test("valued は固定の時刻を返す", () => {
  const scope = {};
  clock.valued(42).registerIn(scope);
  expect(clock.nowIn(scope)).toBe(42);
});

test("同じ scope に2つ目の provider は登録できない", () => {
  const scope = {};
  clock.valued(0).registerIn(scope);
  expect(() => clock.valued(1).registerIn(scope)).toThrow(Panic);
});
