import { expect, test } from "vite-plus/test";
import { Brand } from "./slot.ts";

test("Brand は自分が封をした値だけを開ける", () => {
  const numbers = new Brand<number>();
  const strings = new Brand<string>();
  const boxed = numbers.box(1);
  expect(numbers.open(boxed)).toBe(1);
  expect(strings.open(boxed)).toBeUndefined();
  expect(numbers.open({})).toBeUndefined();
  expect(Object.isFrozen(boxed)).toBe(true);
});
