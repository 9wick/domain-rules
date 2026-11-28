import { expectTypeOf, test } from "vite-plus/test";
import type { UniqueNames } from "./unique-names.ts";

type Named<N extends string> = { readonly name: N };

test("名前が文字列リテラルで重ならない tuple だけを受け付ける", () => {
  expectTypeOf<UniqueNames<[Named<"a">, Named<"b">]>>().toEqualTypeOf<unknown>();
  expectTypeOf<UniqueNames<[Named<"a">, Named<"a">]>>().toEqualTypeOf<{ readonly "duplicate names": "a" }>();
  expectTypeOf<UniqueNames<[Named<"a" | "b">]>>().toEqualTypeOf<{
    readonly "name must be a single string literal": Named<"a" | "b">;
  }>();
  expectTypeOf<UniqueNames<Named<"a">[]>>().toEqualTypeOf<{ readonly "pass a fixed-length tuple": never }>();
});
