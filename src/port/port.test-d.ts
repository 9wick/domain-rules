import { Result } from "@praha/byethrow";
import { expectTypeOf, test } from "vite-plus/test";
import { port, type Port } from "../index.ts";

test("port を広い型に代入して、宣言と違う型の実装を登録することはできない", () => {
  const p = port("p").of<(n: number) => string, "E">();
  // @ts-expect-error 型引数が違う port の型には代入できない
  const widened: Port<"p", [number], unknown, unknown> = p;
  expectTypeOf(widened).not.toBeNever();
  // @ts-expect-error 実装を広い型で受け取る provider の型にも代入できない
  const providable: { readonly provider: (impl: (n: number) => Result.Result<unknown, unknown>) => unknown } = p;
  expectTypeOf(providable).not.toBeNever();
});
