import * as v from "valibot";
import { expectTypeOf, test } from "vite-plus/test";
import {
  ArticleIdNewSchema,
  UserIdExistedSchema,
  article,
  articleIdAssigned,
  blogExists,
  existingArticleId,
  findArticleById,
  findBlog,
  newArticleId,
  requireExistingUser,
  reviewerExists,
} from "../test/blog/domain.ts";
import { bind, clock, modelRules, provide, ruleset } from "./index.ts";

test("provider が足りなければ型エラー", () => {
  const set = modelRules(article)
    .load(findArticleById)
    .save(ruleset(blogExists).add(reviewerExists).add(existingArticleId).add(articleIdAssigned));
  const run = () => {
    // @ts-expect-error findBlog などの provider がない
    bind([set], { providers: [provide(clock, () => 0)] });
    bind([set], {
      providers: [
        provide.value(clock, 0),
        provide.value(findArticleById, null),
        provide.value(findBlog, null),
        provide.value(requireExistingUser, v.parse(UserIdExistedSchema, "usr_1")),
        provide.value(newArticleId, v.parse(ArticleIdNewSchema, "art_1")),
      ],
    });
  };
  expectTypeOf(run).toBeFunction();
});
