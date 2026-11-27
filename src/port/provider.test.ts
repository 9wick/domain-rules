import { expect, test } from "vite-plus/test";
import { Panic } from "../shared/panic.ts";
import { Context, provide } from "./provider.ts";
import { Slot } from "./slot.ts";

test("Context は差し込み口ごとに、渡した provider の実装を持つ", () => {
  const a = new Slot<"a", () => number>("a");
  const b = new Slot<"b", () => string>("b");
  const context = new Context([a.provider(() => 1)]);
  expect(context.has(a)).toBe(true);
  expect(a.implIn(context)?.()).toBe(1);
  expect(context.has(b)).toBe(false);
  expect(b.implIn(context)).toBeUndefined();
  expect(Object.isFrozen(context)).toBe(true);
});

test("同じ差し込み口の provider を2つ渡すと Panic にする", () => {
  const a = new Slot<"a", () => number>("a");
  expect(() => new Context([a.provider(() => 1), a.provider(() => 2)])).toThrow(Panic);
  expect(() => new Context([a.provider(() => 1), a.provider(() => 2)])).toThrow(
    'bind: port "a" の provider が重複しています',
  );
});

test("同じ名前でも、別の差し込み口の provider は別のものとして持つ", () => {
  const a = new Slot<"same", () => number>("same");
  const other = new Slot<"same", () => number>("same");
  const context = new Context([a.provider(() => 1), other.provider(() => 2)]);
  expect([a.implIn(context)?.(), other.implIn(context)?.()]).toEqual([1, 2]);
});

const impl = () => 1;

test("provide は対象の provider で、provide.value は対象の valued で provider を作る", () => {
  const made = new Slot<"p", () => number>("p").provider(impl);
  const received: unknown[] = [];
  const target = {
    provider: (impl: () => number) => (received.push(impl), made),
    valued: (v: number) => (received.push(v), made),
  };
  expect(provide(target, impl)).toBe(made);
  expect(provide.value(target, 2)).toBe(made);
  expect(received).toEqual([impl, 2]);
});
