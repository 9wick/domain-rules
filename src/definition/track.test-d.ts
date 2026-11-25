import { expectTypeOf, test } from "vite-plus/test";
import { Track } from "./track.ts";

test("assuming は前提の型を状態の型に重ねる", () => {
  const track = new Track<"save", "item", { readonly n: number }>("save", "item");
  expectTypeOf(track.assuming<{ readonly checked: true }>()).toEqualTypeOf<
    Track<"save", "item", { readonly n: number } & { readonly checked: true }>
  >();
});

test("線路の種類が違う Track は代入できない", () => {
  const save = new Track<"save", "item", unknown>("save", "item");
  // @ts-expect-error 保存の線路を削除の線路として使えない
  const asDelete: Track<"delete", "item", unknown> = save;
  expectTypeOf(asDelete).not.toBeNever();
});
