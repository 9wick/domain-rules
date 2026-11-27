import { expect, test } from "vite-plus/test";
import { clock } from "./clock.ts";
import { Context } from "./provider.ts";

test("provider を渡した Context でだけ、provider の時刻を返す", () => {
  const empty = new Context([]);
  expect(clock.providedIn(empty)).toBe(false);
  expect(clock.nowIn(empty)).toBeUndefined();
  let now = 1;
  const context = new Context([clock.provider(() => now++)]);
  expect(clock.providedIn(context)).toBe(true);
  expect([clock.nowIn(context), clock.nowIn(context)]).toEqual([1, 2]);
});

test("valued は固定の時刻を返す", () => {
  expect(clock.nowIn(new Context([clock.valued(42)]))).toBe(42);
});
