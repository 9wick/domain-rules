import { Result } from "@praha/byethrow";
import { test } from "vite-plus/test";
import { article, type ArticleValue } from "../../../test/blog/domain.ts";
import { actor, changed, rule } from "../../index.ts";

test("使えない線路の when は型エラー", () => {
  rule(article.onDelete, {
    name: "x",
    // @ts-expect-error changed は保存の線路だけ
    when: changed("slug"),
    check: () => Result.succeed(),
  });
  rule(article.onSave, {
    name: "x",
    // @ts-expect-error 存在しない項目
    when: changed("slugg"),
    check: () => Result.succeed(),
  });
});

test("actor の when は、状態の型を受け取れる", () => {
  rule(article.onSave, {
    name: "著者だけ",
    when: actor((a, s: { next: ArticleValue }) => a.id === s.next.authorId),
    check: () => Result.succeed(),
  });
});
