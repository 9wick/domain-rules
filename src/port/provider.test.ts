import { expect, test } from "vite-plus/test";
import { Panic } from "../shared/panic.ts";
import { provide, Provider, register } from "./provider.ts";

test("registerIn は、作るときに渡した登録の処理を scope に対して呼ぶ", () => {
  const scopes: object[] = [];
  const provider = new Provider("p", (scope) => scopes.push(scope));
  const scope = {};
  provider.registerIn(scope);
  expect(scopes).toEqual([scope]);
  expect(Object.isFrozen(provider)).toBe(true);
});

test("register は scope ごとに1つの実装だけを登録し、2つ目は Panic にする", () => {
  const impls = new WeakMap<object, string>();
  const scope = {};
  register(impls, scope, "first", "p");
  register(impls, {}, "other scope", "p");
  expect(impls.get(scope)).toBe("first");
  expect(() => register(impls, scope, "second", "p")).toThrow(Panic);
  expect(() => register(impls, scope, "second", "p")).toThrow('bind: port "p" の provider が重複しています');
});

const impl = () => 1;

test("provide は対象の provider で、provide.value は対象の valued で provider を作る", () => {
  const made = new Provider("p", () => undefined);
  const received: unknown[] = [];
  const target = {
    provider: (impl: () => number) => (received.push(impl), made),
    valued: (v: number) => (received.push(v), made),
  };
  expect(provide(target, impl)).toBe(made);
  expect(provide.value(target, 2)).toBe(made);
  expect(received).toEqual([impl, 2]);
});
