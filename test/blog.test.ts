import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { bind, clock, open, plan, provide, type Provider } from "../src/index.ts";
import {
  articleRules,
  findArticle,
  findArticleById,
  findArticlesInBlog,
  findBlog,
  newArticleId,
  previewArticleRules,
  requireExistingUser,
  ArticleIdExistedSchema,
  ArticleIdNewSchema,
  BlogIdExistedSchema,
  UserIdExistedSchema,
  UserIdSchema,
  type AppActor,
  type Blog,
  type ExistingArticle,
} from "./blog/domain.ts";

const NOW = 1_700_000_000_000;
const author: AppActor = { id: v.parse(UserIdSchema, "usr_author"), role: "MEMBER" };
const reviewer: AppActor = { id: v.parse(UserIdSchema, "usr_reviewer"), role: "MEMBER" };
const guest: AppActor = { id: v.parse(UserIdSchema, "usr_guest"), role: "GUEST" };

const draft: ExistingArticle = {
  id: v.parse(ArticleIdExistedSchema, "art_1"),
  blogId: v.parse(BlogIdExistedSchema, "blg_1"),
  status: "DRAFT",
  authorId: v.parse(UserIdSchema, "usr_author"),
  reviewerId: v.parse(UserIdExistedSchema, "usr_reviewer"),
  slug: "hello",
  publishAt: NOW + 1000,
  approvedAt: NOW,
};
const openBlog: Blog = { id: v.parse(BlogIdExistedSchema, "blg_1"), acceptsPosts: true };

const setup = (
  overrides: { existing?: ExistingArticle | null; articles?: ExistingArticle[]; blog?: Blog | null } = {},
) => {
  const calls: string[] = [];
  const record =
    <T>(name: string, value: T) =>
    (...args: unknown[]) => {
      calls.push(`${name}(${args.join(",")})`);
      return Result.succeed(value);
    };
  const providers = [
    provide(findArticleById, record("findArticleById", overrides.existing === undefined ? draft : overrides.existing)),
    provide(newArticleId, record("newArticleId", v.parse(ArticleIdNewSchema, "art_new"))),
    provide(requireExistingUser, (id) => {
      calls.push(`requireExistingUser(${id})`);
      return Promise.resolve(
        id.startsWith("usr_")
          ? Result.succeed(v.parse(UserIdExistedSchema, id))
          : Result.fail("USER_NOT_FOUND" as const),
      );
    }),
    provide(findBlog, record("findBlog", overrides.blog === undefined ? openBlog : overrides.blog)),
    provide(findArticlesInBlog, record("findArticlesInBlog", overrides.articles ?? [])),
    provide(findArticle, record("findArticle", overrides.existing === undefined ? draft : overrides.existing)),
    provide(clock, () => NOW),
  ] as const;
  return { domain: bind([articleRules, previewArticleRules], { providers }), calls };
};

const newArticle = {
  blogId: "blg_1",
  authorId: "usr_author",
  reviewerId: "usr_reviewer",
  slug: "new",
  publishAt: NOW + 1000,
};

describe("create", () => {
  test("検証して既定値を入れ、昇格させた値に封をする", async () => {
    const { domain } = setup();
    const r = await domain.article.create({ input: newArticle, actor: author });
    const { pre, next, actor } = open(Result.unwrap(r));
    expect(pre).toBeNull();
    expect(next).toEqual({ ...newArticle, id: "art_new", status: "DRAFT", approvedAt: null });
    expect(actor).toBe(author);
    expect(Object.isFrozen(next)).toBe(true);
  });

  test("入力が schema を満たさなければ input で失敗し、問題をすべて返す", async () => {
    const { domain, calls } = setup();
    const r = await domain.article.create({ input: { ...newArticle, slug: "", publishAt: 1.5 }, actor: author });
    expect(Result.unwrapError(r).step).toBe("input");
    expect(Result.unwrapError(r).error).toMatchObject({
      issues: [{ path: [{ key: "slug" }] }, { path: [{ key: "publishAt" }] }],
    });
    expect(calls).toEqual([]);
  });

  test("schema にない項目と id は受け付けない", async () => {
    const { domain } = setup();
    // @ts-expect-error schema にない項目と id を、型を通さずに渡したときの実行時の振る舞いを確かめる
    const r = await domain.article.create({ input: { ...newArticle, extra: 1, id: "art_x" }, actor: author });
    expect(Result.unwrapError(r)).toMatchObject({
      step: "input",
      error: { issues: [{ path: ["extra"] }, { path: ["id"] }] },
    });
  });

  test("最初に失敗した rule で止まり、後ろの rule は実行しない", async () => {
    const { domain, calls } = setup();
    const r = await domain.article.create({ input: newArticle, actor: guest });
    expect(Result.unwrapError(r)).toEqual({ step: "memberOnly", error: "NOT_MEMBER" });
    expect(calls).toEqual([]);
  });

  test("port の失敗は、その rule の失敗になる", async () => {
    const failing = bind([articleRules], {
      providers: [
        provide(findArticleById, () => Result.succeed(null)),
        provide(newArticleId, () => Result.succeed(v.parse(ArticleIdNewSchema, "art_new"))),
        provide(requireExistingUser, () => Result.fail("USER_NOT_FOUND" as const)),
        provide(findBlog, () => Result.succeed(openBlog)),
        provide(findArticlesInBlog, () => Result.succeed([])),
        provide(clock, () => NOW),
      ],
    });
    const r = await failing.article.create({ input: newArticle, actor: author });
    expect(Result.unwrapError(r)).toEqual({ step: "reviewerExists", error: "USER_NOT_FOUND" });
  });

  test("check の失敗の値はそのまま返る", async () => {
    const { domain } = setup({ articles: [{ ...draft, slug: "new" }] });
    const r = await domain.article.create({ input: newArticle, actor: author });
    expect(Result.unwrapError(r)).toEqual({ step: "uniqueSlug", error: "DUPLICATED_SLUG" });
  });
});

describe("update", () => {
  test("入力にない項目は既存の値を残し、変わらない値は取得しない", async () => {
    const { domain, calls } = setup();
    const r = await domain.article.update({ input: { id: "art_1", slug: "renamed" }, actor: author });
    const { pre, next } = open(Result.unwrap(r));
    expect(pre).toEqual(draft);
    expect(next).toEqual({ ...draft, slug: "renamed" });
    expect(calls).toEqual(["findArticleById(art_1)", "findArticlesInBlog(blg_1)"]);
  });

  test("null は空にする", async () => {
    const { domain } = setup();
    const r = await domain.article.update({ input: { id: "art_1", approvedAt: null }, actor: author });
    expect(open(Result.unwrap(r)).next.approvedAt).toBeNull();
  });

  test("入力にある項目だけを検証する", async () => {
    const { domain } = setup();
    const r = await domain.article.update({ input: { id: "art_1", slug: "" }, actor: author });
    expect(Result.unwrapError(r)).toMatchObject({ step: "input", error: { issues: [{ path: ["slug"] }] } });
  });

  test("既存の値がなければ load で失敗する", async () => {
    const { domain } = setup({ existing: null });
    const r = await domain.article.update({ input: { id: "art_9", slug: "x" }, actor: author });
    expect(Result.unwrapError(r)).toEqual({ step: "load", error: "ARTICLE_NOT_FOUND" });
  });

  test("when が値の変化を見て rule を当てる", async () => {
    const { domain } = setup();
    const byAuthor = await domain.article.update({ input: { id: "art_1", status: "PUBLISHED" }, actor: author });
    expect(Result.unwrapError(byAuthor)).toEqual({ step: "publishByReviewer", error: "NOT_REVIEWER" });
    const back = setup({ existing: { ...draft, status: "PUBLISHED" } });
    const archived = await back.domain.article.update({ input: { id: "art_1", status: "DRAFT" }, actor: author });
    expect(Result.unwrapError(archived)).toEqual({
      step: "allowedStatusTransition",
      error: "STATUS_CHANGE_NOT_ALLOWED",
    });
    const locked = await back.domain.article.update({ input: { id: "art_1", slug: "other" }, actor: author });
    expect(Result.unwrapError(locked)).toEqual({
      step: "slugChangeAfterPublishByAdmin",
      error: "SLUG_LOCKED",
    });
    const admin = await back.domain.article.update({
      input: { id: "art_1", slug: "other" },
      actor: { ...author, role: "ADMIN" },
    });
    expect(Result.isSuccess(admin)).toBe(true);
  });

  test("作成後に変えられない項目", async () => {
    const { domain } = setup();
    const r = await domain.article.update({ input: { id: "art_1", authorId: "usr_other" }, actor: author });
    expect(Result.unwrapError(r)).toEqual({
      step: "immutable",
      error: { code: "IMMUTABLE_FIELD_CHANGED", field: "authorId" },
    });
  });
});

describe("upsert", () => {
  test("id がなければ作成、あれば更新", async () => {
    const { domain } = setup();
    const created = open(Result.unwrap(await domain.article.upsert({ input: newArticle, actor: author })));
    expect(created.pre).toBeNull();
    const updated = open(
      Result.unwrap(await domain.article.upsert({ input: { id: "art_1", slug: "s" }, actor: author })),
    );
    expect(updated.pre).toEqual(draft);
  });

  test("id があって見つからなければ load で失敗する", async () => {
    const { domain } = setup({ existing: null });
    const r = await domain.article.upsert({ input: { ...newArticle, id: "art_9" }, actor: author });
    expect(Result.unwrapError(r)).toEqual({ step: "load", error: "ARTICLE_NOT_FOUND" });
  });
});

describe("delete", () => {
  test("削除の rule を通り、削除する対象に封をする", async () => {
    const { domain } = setup();
    const { pre, actor } = open(Result.unwrap(await domain.article.delete({ input: { id: "art_1" }, actor: author })));
    expect(pre).toEqual(draft);
    expect(actor).toBe(author);
  });

  test("下書きでなければ失敗する", async () => {
    const { domain } = setup({ existing: { ...draft, status: "PUBLISHED" } });
    const r = await domain.article.delete({ input: { id: "art_1" }, actor: author });
    expect(Result.unwrapError(r)).toEqual({ step: "deleteOnlyDraft", error: "NOT_DRAFT" });
  });
});

describe("decide", () => {
  test("output が組み立てた値を返す", async () => {
    const { domain } = setup();
    const r = await domain.previewArticle.decide({ input: { blogId: "blg_1", articleId: "art_1" }, actor: reviewer });
    expect(open(Result.unwrap(r)).value).toEqual({ article: draft, viewerRole: "reviewer" });
  });

  test("rule の失敗で止まる", async () => {
    const { domain } = setup({ existing: null });
    const r = await domain.previewArticle.decide({ input: { blogId: "blg_1", articleId: "art_1" }, actor: reviewer });
    expect(Result.unwrapError(r)).toEqual({ step: "articleExists", error: "ARTICLE_NOT_FOUND" });
  });
});

describe("封をした値", () => {
  test("作り直した値は open できない", async () => {
    const { domain } = setup();
    const p = Result.unwrap(await domain.article.create({ input: newArticle, actor: author }));
    // @ts-expect-error 作り直した値は封をした値の型にならない
    expect(() => open({ ...p })).toThrow("open: not a sealed value created by a method");
  });
});

describe("bind", () => {
  const base: readonly Provider[] = [
    provide.value(findArticleById, null),
    provide.value(newArticleId, v.parse(ArticleIdNewSchema, "art_1")),
    provide.value(requireExistingUser, v.parse(UserIdExistedSchema, "usr_1")),
    provide.value(findBlog, openBlog),
    provide.value(findArticlesInBlog, []),
    provide.value(clock, NOW),
  ];

  test("provider の不足と重複、rule の組の重複は起動時にエラー", () => {
    expect(() => bind([articleRules], { providers: base.slice(1) })).toThrow(/findArticleById/);
    expect(() => bind([articleRules], { providers: [...base, provide.value(clock, 0)] })).toThrow(/clock/);
    // @ts-expect-error 同じ名前の rule の組は型でも弾く
    expect(() => bind([articleRules, articleRules], { providers: base })).toThrow(/article/);
  });
});

describe("plan", () => {
  test("線路を実行せずに表示する", () => {
    const p = plan(articleRules);
    expect(p.save?.[0]).toEqual({
      id: "memberOnly",
      description: "記事を変更できるのはメンバーだけ",
      when: { kind: "always" },
      ports: [],
    });
    expect(p.save?.find((r) => r.id === "uniqueSlug")).toEqual({
      id: "uniqueSlug",
      description: "slug はブログ内で一意",
      when: { kind: "changed", field: "slug" },
      ports: ["findArticlesInBlog"],
    });
    expect(p.delete?.map((r) => r.id)).toEqual(["memberOnly", "deleteOnlyDraft"]);
  });
});
