import { expectTypeOf, test } from "vite-plus/test";
import { provide, type Provider } from "./provider.ts";

declare const target: {
  readonly provider: (impl: (n: number) => string) => Provider<"p">;
  readonly valued: (v: string) => Provider<"p">;
};

test("provide の実装は、対象が受け取る実装の型に合わせる", () => {
  expectTypeOf(provide(target, (n) => String(n))).toEqualTypeOf<Provider<"p">>();
  // @ts-expect-error 結果の型が違う
  provide(target, () => 1);
  // @ts-expect-error 値の型が違う
  provide.value(target, 1);
});

test("provider は同じ形の object からは作れない", () => {
  // @ts-expect-error name と slot を持つだけの object は provider ではない
  const forged: Provider<"p"> = { name: "p", slot: {} };
  expectTypeOf(forged).not.toBeNever();
});
