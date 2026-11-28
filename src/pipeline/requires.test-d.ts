import { expectTypeOf, test } from "vite-plus/test";
import { port } from "../port/port.ts";
import type { StrictRecord } from "./requires.ts";

const p = port("p").of<(n: number) => string>();

test("key の決まった record だけを受け付ける", () => {
  expectTypeOf<StrictRecord<{ readonly p: typeof p }>>().toEqualTypeOf<unknown>();
  expectTypeOf<StrictRecord<Readonly<Record<string, typeof p>>>>().toEqualTypeOf<{
    readonly "records with an index signature are not allowed": never;
  }>();
  expectTypeOf<StrictRecord<{ readonly p?: typeof p }>>().toEqualTypeOf<{
    readonly "optional keys are not allowed": "p";
  }>();
});
