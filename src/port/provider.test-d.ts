import { Result } from "@praha/byethrow";
import { expectTypeOf, test } from "vite-plus/test";
import { port, provide, type Provider } from "../index.ts";

test("provider の実装は port の型に合わせる", () => {
  const p = port("p").of<(n: number) => string, "E">();
  provide(p, (n) => Result.succeed(String(n)));
  // @ts-expect-error 結果の型が違う
  provide(p, () => Result.succeed(1));
});

test("provider は port の provider からしか作れない", () => {
  const p = port("p").of<(n: number) => string>();
  // @ts-expect-error 同じ形の object では provider を作れない
  const forged: Provider<"p"> = { name: "p", registerIn: () => undefined };
  expectTypeOf(forged).not.toBeNever();
  expectTypeOf(provide(p, (n) => Result.succeed(String(n)))).toEqualTypeOf<Provider<"p">>();
});
