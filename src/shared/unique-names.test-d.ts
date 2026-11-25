import { expectTypeOf, test } from "vite-plus/test";
import type { UniqueNames } from "./unique-names.ts";

type Named<N extends string> = { readonly name: N };

test("名前が文字列リテラルで重ならない tuple だけを受け付ける", () => {
  expectTypeOf<UniqueNames<[Named<"a">, Named<"b">]>>().toEqualTypeOf<unknown>();
  expectTypeOf<UniqueNames<[Named<"a">, Named<"a">]>>().toEqualTypeOf<{ readonly "name が重複している": "a" }>();
  expectTypeOf<UniqueNames<[Named<"a" | "b">]>>().toEqualTypeOf<{
    readonly "name は1つの文字列リテラルにする": Named<"a" | "b">;
  }>();
  expectTypeOf<UniqueNames<Named<"a">[]>>().toEqualTypeOf<{ readonly "長さの決まった tuple を渡す": never }>();
});
