import { expectTypeOf, test } from "vite-plus/test";
import { article, findArticleById } from "../../test/blog/domain.ts";
import { alwaysAllow, bind, clock, modelRules, provide, ruleset } from "../index.ts";

test("alwaysAllow だけの delete は、確かめずに削除できるメソッドを作る", () => {
  const set = modelRules(article).load(findArticleById).delete(ruleset(alwaysAllow));
  const bound = bind([set], { providers: [provide.value(clock, 0), provide.value(findArticleById, null)] });
  expectTypeOf(bound.article).toHaveProperty("delete");
  expectTypeOf(bound.article).not.toHaveProperty("create");
});
