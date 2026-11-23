import { Result } from "@praha/byethrow";
import { describe, expectTypeOf, test } from "vitest";
import { actor, always, bind, changed, clock, modelRules, open, port, provide, rule, type Persistable } from "../src/index.ts";
import {
  article,
  articleIdAssigned,
  articleRules,
  blogAcceptsPosts,
  blogExists,
  existingArticleId,
  findArticleById,
  findBlog,
  newArticleId,
  requireExistingUser,
  memberCanSave,
  onlyDraftIsDeletable,
  previewArticleRules,
  reviewerExists,
  type ArticleIdExisted,
  type ArticleValue,
  type ArticleIdNew,
  type ExistingArticle,
  type MemberActor,
  type UserIdExisted,
} from "./blog/domain.ts";

declare const domain: ReturnType<typeof bind<readonly [typeof articleRules, typeof previewArticleRules], readonly []>>;

describe("型", () => {
  test("束ねたメソッドの返り値は、昇格した型を持つ封をした値", async () => {
    const r = await domain.article.update({ input: { id: "art_1", status: "PUBLISHED" }, actor: { id: "usr_1" as never, role: "MEMBER" } });
    if (Result.isFailure(r)) {
      expectTypeOf(r.error.step).toEqualTypeOf<
        | "input"
        | "load"
        | "記事を変更できるのはメンバーだけ"
        | "status は許可された変化だけ"
        | "作成後に変えられない項目: blogId, authorId"
        | "ブログが存在する"
        | "レビュアーが存在する"
        | "著者とレビュアーは別の人"
        | "slug はブログ内で一意"
        | "公開日時は未来"
        | "公開できるのは今のレビュアーだけ"
        | "作成後にレビュアーを変えられるのは著者だけ"
        | "公開後の slug を変えられるのは管理者だけ"
        | "公開中の記事は承認済み"
        | "投稿を受け付けているブログ"
        | "既存の記事の id"
        | "新しい記事に id を付ける"
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
    const r = await domain.article.create({ input: {}, actor: { id: "usr_1" as never, role: "MEMBER" } });
    if (Result.isFailure(r) && r.error.step === "レビュアーが存在する") {
      expectTypeOf(r.error.error).toEqualTypeOf<"USER_NOT_FOUND" | { readonly type: "INFRA"; readonly cause: unknown }>();
    }
  });

  test("action は output の値を返す", async () => {
    const r = await domain.previewArticle.decide({ input: { blogId: "blg_1", articleId: "art_1" }, actor: { id: "usr_1" as never, role: "MEMBER" } });
    if (Result.isSuccess(r)) {
      expectTypeOf(open(r.value).value.viewerRole).toEqualTypeOf<"author" | "reviewer">();
    }
  });

  test("前提の型が成り立たない並びは型エラー", () => {
    modelRules(article, {
      load: findArticleById,
      // @ts-expect-error blogAcceptsPosts は blogExists のあとでなければならない
      save: [memberCanSave, blogAcceptsPosts, blogExists, reviewerExists, existingArticleId, articleIdAssigned],
    });
  });

  test("永続化の型にならない並びは型エラー", () => {
    modelRules(article, {
      load: findArticleById,
      // @ts-expect-error reviewerExists がないと next.reviewerId が UserId のまま
      save: [blogExists, existingArticleId, articleIdAssigned],
    });
    modelRules(article, {
      load: findArticleById,
      // @ts-expect-error articleIdAssigned がないと next.id に null が残る
      save: [blogExists, reviewerExists, existingArticleId],
    });
    modelRules(article, {
      load: findArticleById,
      save: [blogExists, reviewerExists, existingArticleId, articleIdAssigned],
    });
  });

  test("線路の違う rule は並べられない", () => {
    modelRules(article, {
      load: findArticleById,
      // @ts-expect-error 削除の rule を保存の並びに置いている
      save: [onlyDraftIsDeletable, blogExists, reviewerExists, existingArticleId, articleIdAssigned],
    });
  });

  test("delete には load が要る", () => {
    // @ts-expect-error load がない
    modelRules(article, { delete: [onlyDraftIsDeletable] });
  });

  test("使えない線路の when は型エラー", () => {
    rule(article.delete, {
      name: "x",
      // @ts-expect-error changed は保存の線路だけ
      when: changed("slug"),
      check: () => Result.succeed(),
    });
    rule(article.save, {
      name: "x",
      // @ts-expect-error 存在しない項目
      when: changed("slugg"),
      check: () => Result.succeed(),
    });
  });

  test("always 以外の when で昇格すると、昇格していない型との和になる", () => {
    const maybe = rule(article.save, {
      name: "たまに昇格",
      when: changed("reviewerId"),
      check: ({ next }) => Result.succeed({ next: { reviewerId: next.reviewerId as UserIdExisted } }),
    });
    modelRules(article, {
      load: findArticleById,
      // @ts-expect-error 当たらないときに reviewerId が UserId のまま残る
      save: [blogExists, maybe, existingArticleId, articleIdAssigned],
    });
  });

  test("provider が足りなければ型エラー", () => {
    const set = modelRules(article, { load: findArticleById, save: [blogExists, reviewerExists, existingArticleId, articleIdAssigned] });
    const run = () => {
      // @ts-expect-error findBlog などの provider がない
      bind([set], { providers: [provide(clock, () => 0)] });
      bind([set], {
        providers: [
          provide.value(clock, 0),
          provide.value(findArticleById, null),
          provide.value(findBlog, null),
          provide.value(requireExistingUser, "usr_1" as UserIdExisted),
          provide.value(newArticleId, "art_1" as ArticleIdNew),
        ],
      });
    };
    expectTypeOf(run).toBeFunction();
  });

  test("provider の実装は port の型に合わせる", () => {
    const p = port("p").of<(n: number) => string, "E">();
    provide(p, (n) => Result.succeed(String(n)));
    // @ts-expect-error 結果の型が違う
    provide(p, () => Result.succeed(1));
  });

  test("with で前提を付けない rule の pre は永続化の型", () => {
    rule(article.save, {
      name: "x",
      when: always,
      check: ({ pre }) => {
        expectTypeOf(pre?.reviewerId).toEqualTypeOf<UserIdExisted | undefined>();
        return Result.succeed();
      },
    });
  });
});

export const actorWithState = rule(article.save, {
  name: "著者だけ",
  when: actor((a, s: { next: ArticleValue }) => a.id === s.next.authorId),
  check: () => Result.succeed(),
});
