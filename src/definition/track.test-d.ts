import { Result } from "@praha/byethrow";
import { expectTypeOf, test } from "vite-plus/test";
import {
  article,
  articleIdAssigned,
  blogExists,
  existingArticleId,
  findArticleById,
  reviewerExists,
  type Article,
  type ArticleId,
  type ArticleIdExisted,
  type ExistingArticle,
} from "../../test/blog/domain.ts";
import { always, modelRules, port, rule, ruleset } from "../index.ts";

test("load の型を前提にする線路は、その型から始める", () => {
  const existingOnly = rule(article.onSave.assuming<{ pre: ExistingArticle | null }>(), {
    name: "既存の記事だけ",
    when: always,
    check: ({ pre }) => {
      expectTypeOf(pre?.id).toExtend<ArticleIdExisted | undefined>();
      return Result.succeed();
    },
  });
  const save = ruleset(existingOnly).add(blogExists).add(reviewerExists).add(existingArticleId).add(articleIdAssigned);
  modelRules(article).load(findArticleById).save(save);
  modelRules(article)
    .load(port("findAny").of<(id: ArticleId) => Article | null>())
    // @ts-expect-error 永続化の型を返す load では、pre が ExistingArticle にならない
    .save(save);
});
