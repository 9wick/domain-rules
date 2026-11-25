import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expectTypeOf, test } from "vite-plus/test";
import {
  UserIdExistedSchema,
  article,
  articleIdAssigned,
  blogExists,
  existingArticleId,
  findArticleById,
  reviewerExists,
} from "../../test/blog/domain.ts";
import { alwaysAllow, changed, model, modelRules, port, rule, ruleset } from "../index.ts";
import { findItem, item, twice } from "../testing/fixtures.ts";

test("load の返り値は、入力の型にも代入できなければならない", () => {
  const appointment = model({
    name: "appointment",
    schema: {
      input: v.object({ id: v.optional(v.string()), date: v.string() }),
      persisted: v.object({ id: v.string(), date: v.date() }),
    },
  });
  const find = port("findAppointment").of<(id: string) => { id: string; date: Date } | null>();
  // @ts-expect-error 更新で date を省略すると、next の date に入力の型ではない Date が入る
  modelRules(appointment).load(find);
});

test("load は検証した id を受け取れなければならない", () => {
  const item = model({
    name: "item",
    schema: { input: v.object({ id: v.optional(v.string()) }), persisted: v.object({ id: v.string() }) },
  });
  const narrow = port("findNarrow").of<(id: "fixed") => { id: string } | null>();
  // @ts-expect-error 検証した id は string で、"fixed" しか受け取らない load には渡せない
  modelRules(item).load(narrow);
  modelRules(item).load(port("findWide").of<(id: string | number) => { id: string } | null>());
});

test("同じメソッドを2回書くことと、load を save よりあとに書くことは型エラー", () => {
  const save = ruleset(twice("a"));
  // @ts-expect-error save は1回だけ書ける
  modelRules(item).load(findItem).save(save).save(save);
  // @ts-expect-error delete は1回だけ書ける
  modelRules(item).load(findItem).delete(ruleset(alwaysAllow)).delete(ruleset(alwaysAllow));
  expectTypeOf(modelRules(item).save(save)).not.toHaveProperty("load");
});

test("あるかどうか分からない線路は、rule の組に渡せない", () => {
  const save = ruleset(twice("a"));
  const maybe = [save, undefined][Number(false)];
  // @ts-expect-error 渡したかどうかが型で決まらないと、メソッドがあるかも型で決まらない
  modelRules(item).save(maybe);
  modelRules(item).save(save);
});

test("永続化の型にならない並びは型エラー", () => {
  modelRules(article)
    .load(findArticleById)
    // @ts-expect-error reviewerExists がないと next.reviewerId が UserId のまま
    .save(ruleset(blogExists).add(existingArticleId).add(articleIdAssigned));
  modelRules(article)
    .load(findArticleById)
    // @ts-expect-error articleIdAssigned がないと next.id に null が残る
    .save(ruleset(blogExists).add(reviewerExists).add(existingArticleId));
  modelRules(article)
    .load(findArticleById)
    .save(ruleset(blogExists).add(reviewerExists).add(existingArticleId).add(articleIdAssigned));
});

test("delete には load が要る", () => {
  expectTypeOf(modelRules(article)).not.toHaveProperty("delete");
  expectTypeOf(modelRules(article).load(findArticleById)).toHaveProperty("delete");
});

test("always 以外の when で昇格すると、昇格していない型との和になる", () => {
  const maybe = rule(article.onSave, {
    name: "たまに昇格",
    when: changed("reviewerId"),
    check: ({ next }) => Result.succeed({ next: { reviewerId: v.parse(UserIdExistedSchema, next.reviewerId) } }),
  });
  modelRules(article)
    .load(findArticleById)
    // @ts-expect-error 当たらないときに reviewerId が UserId のまま残る
    .save(ruleset(blogExists).add(maybe).add(existingArticleId).add(articleIdAssigned));
});
