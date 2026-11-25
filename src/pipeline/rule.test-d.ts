import { Result } from "@praha/byethrow";
import { test } from "vite-plus/test";
import { article } from "../../test/blog/domain.ts";
import { always, port, rule } from "../index.ts";

test("check が受け取る port は requires の値からしか決まらない", () => {
  const p = port("p").of<(n: number) => string>();
  rule<"save", "article", unknown, "x", typeof always, Result.Result<void, never>, { readonly p: typeof p }>(
    article.onSave,
    // @ts-expect-error port の型を明示して requires を省くと、check が受け取る port の値がない
    { name: "x", when: always, check: () => Result.succeed() },
  );
  const ports: Readonly<Record<string, typeof p>> = { p };
  // @ts-expect-error index signature の record では、型にある key が値にないことがある
  rule(article.onSave, { name: "y", requires: ports, when: always, check: () => Result.succeed() });
  const optional: { readonly p?: typeof p } = {};
  // @ts-expect-error 省略できる key は、型にあるのに値にないことがある
  rule(article.onSave, { name: "z", requires: optional, when: always, check: () => Result.succeed() });
});
