import { expect, test } from "vite-plus/test";
import { describeWhen, whenOf } from "./when.ts";

test("whenOf は判定の関数に説明を付け、凍結する", () => {
  const positive = whenOf<"save", number>({ kind: "custom", description: "正" }, (n) => n > 0);
  expect([positive(1), positive(-1)]).toEqual([true, false]);
  expect(positive.description).toEqual({ kind: "custom", description: "正" });
  expect(Object.isFrozen(positive)).toBe(true);
});

test("説明を持たない関数の説明は custom になる", () => {
  expect(describeWhen(() => true)).toEqual({ kind: "custom" });
  expect(describeWhen(whenOf({ kind: "onCreate" }, () => true))).toEqual({ kind: "onCreate" });
});
