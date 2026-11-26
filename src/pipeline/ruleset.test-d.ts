import { Result } from "@praha/byethrow";
import { expectTypeOf, test } from "vite-plus/test";
import { Track } from "../definition/track.ts";
import { rule } from "./rule.ts";
import { ruleset, type RulesetError, type RulesetOut } from "./ruleset.ts";
import { always } from "./when/step.ts";

type S = { readonly n: number | null };
const track = new Track<"save", "item", S>("save", "item");

const nonNull = rule(track, {
  name: "null でない",
  when: always,
  check: ({ n }) => (n === null ? Result.fail("NULL" as const) : Result.succeed({ n })),
});
const needsNumber = rule(track.assuming<{ readonly n: number }>(), {
  name: "数を前提にする",
  when: always,
  check: ({ n }) => Result.succeed({ doubled: n * 2 }),
});

test("線路は、rule が重ねた型と失敗の型を持つ", () => {
  const rs = ruleset(nonNull).add(needsNumber);
  expectTypeOf<RulesetOut<typeof rs>>().toExtend<{ readonly n: number; readonly doubled: number }>();
  expectTypeOf<RulesetError<typeof rs>>().toEqualTypeOf<
    | { readonly step: "null でない"; readonly error: "NULL" }
    | { readonly step: "数を前提にする"; readonly error: never }
  >();
});

test("前の rule が前提の型を作っていない並びは型エラー", () => {
  const noop = rule(track, { name: "何もしない", when: always, check: () => Result.succeed() });
  ruleset(noop)
    // @ts-expect-error n が null でないことを確かめる rule がない
    .add(needsNumber);
  ruleset(noop).add(nonNull).add(needsNumber);
});

test("always 以外の when で重ねた型は、重ねていない型との和になる", () => {
  const sometimes = rule(track, {
    name: "たまに",
    when: ({ n }: S) => n !== 0,
    check: ({ n }) => (n === null ? Result.fail("NULL" as const) : Result.succeed({ n })),
  });
  // @ts-expect-error 当たらないときに n が null のまま残る
  ruleset(sometimes).add(needsNumber);
});

test("線路の違う rule は並べられない", () => {
  const onDelete = rule(new Track<"delete", "item", S>("delete", "item"), {
    name: "削除",
    when: always,
    check: () => Result.succeed(),
  });
  ruleset(nonNull)
    // @ts-expect-error 削除の rule を保存の並びに置いている
    .add(onDelete);
});

test("状態の項目を別の型に置き換える rule は足せない", () => {
  const replace = rule(track, { name: "置き換え", when: always, check: () => Result.succeed({ n: "now" }) });
  // @ts-expect-error n は number | null で、string に置き換えられない
  ruleset(replace);
});

test("呼び出し時の input を重ねる rule は足せない", () => {
  type Saving = { readonly input: { readonly n?: number | null } };
  const rewrite = rule(new Track<"save", "item", Saving>("save", "item"), {
    name: "入力を書き換える",
    when: always,
    check: () => Result.succeed({ input: {} }),
  });
  // @ts-expect-error input は呼び出し時の意思なので、狭める形でも変えられない
  ruleset(rewrite);
});
