import { Result } from "@praha/byethrow";
import { expectTypeOf, test } from "vite-plus/test";
import { Track } from "../definition/track.ts";
import { port } from "../port/port.ts";
import { rule } from "./rule.ts";
import { always } from "./when/step.ts";
import { whenOf } from "./when/when.ts";

type S = { readonly n: number };
const track = new Track<"save", "item", S>("save", "item");

test("check は線路の状態の型を受け取り、成功と失敗の型を run の型に残す", () => {
  const r = rule(track, {
    name: "x",
    when: always,
    check: (s) => {
      expectTypeOf(s).toEqualTypeOf<S>();
      return s.n > 0 ? Result.succeed({ checked: true as const }) : Result.fail("NG" as const);
    },
  });
  expectTypeOf<Awaited<ReturnType<typeof r.run>>>().toEqualTypeOf<Result.Result<{ readonly checked: true }, "NG">>();
});

test("線路で使えない when は渡せない", () => {
  const onDelete = new Track<"delete", "item", S>("delete", "item");
  const saveOnly = whenOf<"save", S>({ kind: "custom" }, () => true);
  rule(track, { name: "x", when: saveOnly, check: () => Result.succeed() });
  // @ts-expect-error 保存の線路だけで使える when を、削除の線路の rule に渡している
  rule(onDelete, { name: "x", when: saveOnly, check: () => Result.succeed() });
});

test("check が受け取る port は requires の値からしか決まらない", () => {
  const p = port("p").of<(n: number) => string>();
  rule<"save", "item", S, "x", typeof always, Result.Result<void, never>, { readonly p: typeof p }>(
    track,
    // @ts-expect-error port の型を明示して requires を省くと、check が受け取る port の値がない
    { name: "x", when: always, check: () => Result.succeed() },
  );
  const ports: Readonly<Record<string, typeof p>> = { p };
  // @ts-expect-error index signature の record では、型にある key が値にないことがある
  rule(track, { name: "y", requires: ports, when: always, check: () => Result.succeed() });
  const optional: { readonly p?: typeof p } = {};
  // @ts-expect-error 省略できる key は、型にあるのに値にないことがある
  rule(track, { name: "z", requires: optional, when: always, check: () => Result.succeed() });
});
