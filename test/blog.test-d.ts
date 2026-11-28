import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expectTypeOf, test } from "vite-plus/test";
import { bind, open, type Persistable } from "../src/index.ts";
import {
  UserIdSchema,
  article,
  articleRules,
  previewArticleRules,
  type ArticleIdExisted,
  type ArticleIdNew,
  type ExistingArticle,
  type MemberActor,
  type UserIdExisted,
} from "./blog/domain.ts";

declare const domain: ReturnType<typeof bind<readonly [typeof articleRules, typeof previewArticleRules], readonly []>>;

describe("型", () => {
  test("束ねたメソッドの返り値は、昇格した型を持つ封をした値", async () => {
    const r = await domain.article.update({
      input: { id: "art_1", status: "PUBLISHED" },
      actor: { id: v.parse(UserIdSchema, "usr_1"), role: "MEMBER" },
    });
    if (Result.isFailure(r)) {
      expectTypeOf(r.error.step).toEqualTypeOf<
        | "input"
        | "load"
        | "memberOnly"
        | "defaultFields"
        | "allowedStatusTransition"
        | "immutable"
        | "blogExists"
        | "reviewerExists"
        | "reviewerIsNotAuthor"
        | "uniqueSlug"
        | "publishAtInFuture"
        | "publishByReviewer"
        | "reviewerChangeByAuthor"
        | "slugChangeAfterPublishByAdmin"
        | "publishedIsApproved"
        | "blogAcceptsPosts"
        | "keepExistingId"
        | "assignNewId"
      >();
      return;
    }
    const { pre, next, actor } = open(r.value);
    expectTypeOf(pre).toEqualTypeOf<Readonly<ExistingArticle>>();
    expectTypeOf(next.id).toEqualTypeOf<ArticleIdExisted | ArticleIdNew>();
    expectTypeOf(next.reviewerId).toEqualTypeOf<UserIdExisted>();
    expectTypeOf(actor).toEqualTypeOf<MemberActor>();
    expectTypeOf(r.value).toExtend<Persistable<typeof article, "update">>();
  });

  test("rule の失敗の値に、check の失敗と port の失敗が入る", async () => {
    const r = await domain.article.create({
      input: { blogId: "blg_1", authorId: "usr_1", reviewerId: "usr_2", slug: "s", publishAt: 1 },
      actor: { id: v.parse(UserIdSchema, "usr_1"), role: "MEMBER" },
    });
    if (Result.isFailure(r) && r.error.step === "reviewerExists") {
      expectTypeOf(r.error.error).toEqualTypeOf<
        "USER_NOT_FOUND" | { readonly type: "INFRA"; readonly cause: unknown }
      >();
    }
  });

  test("action は output の値を返す", async () => {
    const r = await domain.previewArticle.decide({
      input: { blogId: "blg_1", articleId: "art_1" },
      actor: { id: v.parse(UserIdSchema, "usr_1"), role: "MEMBER" },
    });
    if (Result.isSuccess(r)) {
      expectTypeOf(open(r.value).value.viewerRole).toEqualTypeOf<"author" | "reviewer">();
    }
  });
});
