import { Result } from "@praha/byethrow";
import { test } from "vite-plus/test";
import { article, blogAcceptsPosts, blogExists, memberCanSave, onlyDraftIsDeletable } from "../../test/blog/domain.ts";
import { always, rule, ruleset } from "../index.ts";

test("前提の型が成り立たない並びは型エラー", () => {
  ruleset(memberCanSave)
    // @ts-expect-error blogAcceptsPosts は blogExists のあとでなければならない
    .add(blogAcceptsPosts);
  ruleset(memberCanSave).add(blogExists).add(blogAcceptsPosts);
});

test("線路の違う rule は並べられない", () => {
  ruleset(memberCanSave)
    // @ts-expect-error 削除の rule を保存の並びに置いている
    .add(onlyDraftIsDeletable);
});

test("状態の項目を別の型に置き換える rule は足せない", () => {
  const replace = rule(article.onSave, {
    name: "置き換え",
    when: always,
    check: () => Result.succeed({ next: { publishAt: "now" } }),
  });
  // @ts-expect-error publishAt は number で、string に置き換えられない
  ruleset(replace);
});
