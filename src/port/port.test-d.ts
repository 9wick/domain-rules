import { Result } from "@praha/byethrow";
import { expectTypeOf, test } from "vite-plus/test";
import { cached, port, type Port, type PortArgs, type PortError, type PortValue } from "./port.ts";

test("port の型から、引数・成功の値・失敗の型を引ける", () => {
  const find = port("find").of<(id: string) => number | null, "DOWN">();
  expectTypeOf<PortArgs<typeof find>>().toEqualTypeOf<[id: string]>();
  expectTypeOf<PortValue<typeof find>>().toEqualTypeOf<number | null>();
  expectTypeOf<PortError<typeof find>>().toEqualTypeOf<"DOWN">();
});

test("provider の実装は port の型に合わせる", () => {
  const p = port("p").of<(n: number) => string, "E">();
  p.provider((n) => Result.succeed(String(n)));
  // @ts-expect-error 結果の型が違う
  p.provider(() => Result.succeed(1));
});

test("port を広い型に代入して、宣言と違う型の実装を登録することはできない", () => {
  const p = port("p").of<(n: number) => string, "E">();
  // @ts-expect-error 型引数が違う port の型には代入できない
  const widened: Port<"p", [number], unknown, unknown> = p;
  expectTypeOf(widened).not.toBeNever();
  // @ts-expect-error 実装を広い型で受け取る provider の型にも代入できない
  const providable: { readonly provider: (impl: (n: number) => Result.Result<unknown, unknown>) => unknown } = p;
  expectTypeOf(providable).not.toBeNever();
});

test("cached にできるのは、値で比べられる引数だけを取る port", () => {
  cached(port("byId").of<(id: string, n: number, flag?: boolean | null) => number>());
  // @ts-expect-error object の引数は同一性で比べることになり、結果を使い回せない
  cached(port("byQuery").of<(q: { readonly id: string }) => number>());
  // @ts-expect-error 配列の引数も同じ
  cached(port("byIds").of<(ids: readonly string[]) => number>());
});
