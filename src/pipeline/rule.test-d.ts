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

test("check の safeTry は、yield* した port の失敗と body が返した Result を合わせて run の型に残す", () => {
  const a = port("a").of<(n: number) => string, "A_DOWN">();
  const b = port("b").of<() => boolean, "B_DOWN">();
  const r = rule(track, {
    name: "x",
    requires: { a, b },
    when: always,
    check: (s, _, { safeTry }) =>
      safeTry(async function* ({ a, b }) {
        const text = yield* a(s.n);
        expectTypeOf(text).toEqualTypeOf<string>();
        const ok = yield* b();
        return ok ? Result.succeed({ text }) : Result.fail("NG" as const);
      }),
  });
  expectTypeOf<Awaited<ReturnType<typeof r.run>>>().toEqualTypeOf<
    Result.Result<{ readonly text: string }, "A_DOWN" | "B_DOWN" | "NG">
  >();
});

test("safeTry で受け取れるのは requires に書いた port だけ", () => {
  const a = port("a").of<() => string, "A_DOWN">();
  rule(track, {
    name: "x",
    requires: { a },
    when: always,
    check: (_, __, { safeTry }) =>
      safeTry(async function* (ports) {
        expectTypeOf(ports).toEqualTypeOf<{ readonly a: () => AsyncGenerator<Result.Failure<"A_DOWN">, string> }>();
        yield* ports.a();
        return Result.succeed();
      }),
  });
});
