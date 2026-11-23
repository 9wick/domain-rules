import { Result } from "@praha/byethrow";
import * as v from "valibot";
import {
  action,
  actionRules,
  actor,
  always,
  and,
  cached,
  changed,
  immutable,
  model,
  modelRules,
  next,
  not,
  onCreate,
  port,
  pre,
  rule,
  type Persisted,
  type Value,
} from "../../src/index.ts";

export type InfraError = { readonly type: "INFRA"; readonly cause: unknown };

export const UserIdSchema = v.pipe(v.string(), v.startsWith("usr_"), v.brand("UserId"));
export const UserIdExistedSchema = v.pipe(UserIdSchema, v.brand("UserIdExisted"));
export type UserId = v.InferOutput<typeof UserIdSchema>;
export type UserIdExisted = v.InferOutput<typeof UserIdExistedSchema>;

export const BlogIdSchema = v.pipe(v.string(), v.startsWith("blg_"), v.brand("BlogId"));
export const BlogIdExistedSchema = v.pipe(BlogIdSchema, v.brand("BlogIdExisted"));
export type BlogId = v.InferOutput<typeof BlogIdSchema>;
export type BlogIdExisted = v.InferOutput<typeof BlogIdExistedSchema>;
export type Blog = { readonly id: BlogIdExisted; readonly acceptsPosts: boolean };

export type AppActor = { readonly id: UserId; readonly role: "GUEST" | "MEMBER" | "ADMIN" };
export type MemberActor = AppActor & { readonly role: "MEMBER" | "ADMIN" };
export const isAdmin = (a: AppActor) => a.role === "ADMIN";

declare module "../../src/index.ts" {
  interface Register {
    actor: AppActor;
  }
}

export const ArticleIdSchema = v.pipe(v.string(), v.startsWith("art_"), v.brand("ArticleId"));
export const ArticleIdExistedSchema = v.pipe(ArticleIdSchema, v.brand("ArticleIdExisted"));
export const ArticleIdNewSchema = v.pipe(ArticleIdSchema, v.brand("ArticleIdNew"));
export type ArticleId = v.InferOutput<typeof ArticleIdSchema>;
export type ArticleIdExisted = v.InferOutput<typeof ArticleIdExistedSchema>;
export type ArticleIdNew = v.InferOutput<typeof ArticleIdNewSchema>;

const articleInput = v.object({
  id: v.optional(ArticleIdSchema),
  blogId: BlogIdSchema,
  status: v.optional(v.picklist(["DRAFT", "PUBLISHED", "ARCHIVED"]), "DRAFT"),
  authorId: UserIdSchema,
  reviewerId: UserIdSchema,
  slug: v.pipe(v.string(), v.minLength(1)),
  publishAt: v.pipe(v.number(), v.integer()),
  approvedAt: v.optional(v.nullable(v.number()), null),
});

export const article = model({
  name: "article",
  schema: {
    input: articleInput,
    persisted: v.object({
      ...articleInput.entries,
      id: v.union([ArticleIdExistedSchema, ArticleIdNewSchema]),
      blogId: BlogIdExistedSchema,
      reviewerId: UserIdExistedSchema,
    }),
  },
});

export type ArticleValue = Value<typeof article>;
export type Article = Persisted<typeof article>;
export type ExistingArticle = Omit<Article, "id"> & { id: ArticleIdExisted };

export const findArticleById = port("findArticleById").of<(id: ArticleId) => ExistingArticle | null, InfraError>();
export const requireExistingUser = port("requireExistingUser").of<(id: UserId) => UserIdExisted, "USER_NOT_FOUND" | InfraError>();
export const findBlog = cached(port("findBlog").of<(id: BlogId) => Blog | null, InfraError>());
export const findArticlesInBlog = cached(
  port("findArticlesInBlog").of<(blogId: BlogId) => readonly ExistingArticle[], InfraError>(),
);
export const newArticleId = port("newArticleId").of<() => ArticleIdNew, InfraError>();

export const isDraft = (a: ArticleValue) => a.status === "DRAFT";
export const isPublished = (a: ArticleValue) => a.status === "PUBLISHED";
export const isApproved = (a: ArticleValue) => a.approvedAt !== null;

export const authorIsNotReviewer = rule(article.save, {
  name: "著者とレビュアーは別の人",
  when: always,
  check: (s) =>
    s.next.authorId !== s.next.reviewerId ? Result.succeed() : Result.fail("SAME_AUTHOR_AND_REVIEWER"),
});

export const uniqueSlugInBlog = rule(article.save, {
  name: "slug はブログ内で一意",
  requires: { findArticlesInBlog },
  when: changed("slug"),
  check: async (s, { findArticlesInBlog }) => {
    const articles = await findArticlesInBlog(s.next.blogId);
    return articles.some((a) => a.slug === s.next.slug && a.id !== s.pre?.id)
      ? Result.fail("DUPLICATED_SLUG")
      : Result.succeed();
  },
});

export const publishAtInFuture = rule(article.save, {
  name: "公開日時は未来",
  when: changed("publishAt"),
  check: (s) => (s.next.publishAt > s.now ? Result.succeed() : Result.fail("PUBLISH_AT_IN_PAST")),
});

export const onlyReviewerPublishes = rule(article.save, {
  name: "公開できるのは今のレビュアーだけ",
  when: changed("status", { pre: "DRAFT", next: "PUBLISHED" }),
  check: (s) => (s.actor.id === s.pre?.reviewerId ? Result.succeed() : Result.fail("NOT_REVIEWER")),
});

export const onlyAuthorChangesReviewer = rule(article.save, {
  name: "作成後にレビュアーを変えられるのは著者だけ",
  when: and(not(onCreate), changed("reviewerId")),
  check: (s) => (s.actor.id === s.pre?.authorId ? Result.succeed() : Result.fail("NOT_AUTHOR")),
});

export const slugLockedAfterPublish = rule(article.save, {
  name: "公開後の slug を変えられるのは管理者だけ",
  when: and(changed("slug"), pre(isPublished), not(actor(isAdmin))),
  check: () => Result.fail("SLUG_LOCKED"),
});

export const publishedIsApproved = rule(article.save, {
  name: "公開中の記事は承認済み",
  when: next(isPublished),
  check: (s) => (isApproved(s.next) ? Result.succeed() : Result.fail("NOT_APPROVED")),
});

const allowedStatusChanges: Record<ArticleValue["status"], readonly ArticleValue["status"][]> = {
  DRAFT: ["DRAFT", "PUBLISHED"],
  PUBLISHED: ["PUBLISHED", "ARCHIVED"],
  ARCHIVED: ["ARCHIVED"],
};

export const statusChangesAreAllowed = rule(article.save, {
  name: "status は許可された変化だけ",
  when: changed("status"),
  check: (s) => {
    const allowed = s.pre === null ? ["DRAFT"] : allowedStatusChanges[s.pre.status];
    return allowed.includes(s.next.status) ? Result.succeed() : Result.fail("STATUS_CHANGE_NOT_ALLOWED");
  },
});

export const onlyDraftIsDeletable = rule(article.delete, {
  name: "削除できるのは下書きだけ",
  when: not(pre(isDraft)),
  check: () => Result.fail("NOT_DRAFT"),
});

export const articleImmutableFields = immutable(article.save, ["blogId", "authorId"]);

export const reviewerExists = rule(article.save, {
  name: "レビュアーが存在する",
  requires: { requireExistingUser },
  when: always,
  check: async ({ pre, next }, { requireExistingUser }) => {
    if (pre && pre.reviewerId === next.reviewerId) {
      return Result.succeed({ next: { reviewerId: pre.reviewerId } });
    }
    const reviewerId = await requireExistingUser(next.reviewerId);
    return Result.succeed({ next: { reviewerId } });
  },
});

export const blogExists = rule(article.save, {
  name: "ブログが存在する",
  requires: { findBlog },
  when: always,
  check: async ({ pre, next }, { findBlog }) => {
    if (pre && pre.blogId === next.blogId) {
      return Result.succeed({ next: { blogId: pre.blogId } });
    }
    const blog = await findBlog(next.blogId);
    return blog ? Result.succeed({ next: { blogId: blog.id } }) : Result.fail("BLOG_NOT_FOUND");
  },
});

export const blogAcceptsPosts = rule(article.save.with<{ next: { blogId: BlogIdExisted } }>(), {
  name: "投稿を受け付けているブログ",
  requires: { findBlog },
  when: changed("status", { next: "PUBLISHED" }),
  check: async ({ next }, { findBlog }) => {
    const blog = await findBlog(next.blogId);
    return blog?.acceptsPosts ? Result.succeed() : Result.fail("BLOG_CLOSED");
  },
});

export const existingArticleId = rule(article.save.with<{ pre: ExistingArticle | null }>(), {
  name: "既存の記事の id",
  when: always,
  check: ({ pre }) => Result.succeed({ next: { id: pre ? pre.id : null } }),
});

export const articleIdAssigned = rule(article.save.with<{ next: { id: ArticleIdExisted | null } }>(), {
  name: "新しい記事に id を付ける",
  requires: { newArticleId },
  when: always,
  check: async ({ next }, { newArticleId }) => Result.succeed({ next: { id: next.id ?? (await newArticleId()) } }),
});

export const isMember = (a: AppActor): a is MemberActor => a.role === "MEMBER" || a.role === "ADMIN";

const memberOnly = {
  name: "記事を変更できるのはメンバーだけ" as const,
  when: always,
  check: ({ actor }: { actor: AppActor }) => (isMember(actor) ? Result.succeed({ actor }) : Result.fail("NOT_MEMBER")),
};

export const memberCanSave = rule(article.save, memberOnly);
export const memberCanDelete = rule(article.delete, memberOnly);

export const articleRules = modelRules(article, {
  load: findArticleById,
  save: [
    memberCanSave,
    statusChangesAreAllowed,
    articleImmutableFields,
    blogExists,
    reviewerExists,
    authorIsNotReviewer,
    uniqueSlugInBlog,
    publishAtInFuture,
    onlyReviewerPublishes,
    onlyAuthorChangesReviewer,
    slugLockedAfterPublish,
    publishedIsApproved,
    blogAcceptsPosts,
    existingArticleId,
    articleIdAssigned,
  ],
  delete: [memberCanDelete, onlyDraftIsDeletable],
});

export const previewArticle = action({
  name: "previewArticle",
  input: v.object({ blogId: BlogIdSchema, articleId: ArticleIdSchema }),
});

export const findArticle = cached(
  port("findArticle").of<(blogId: BlogId, id: ArticleId) => ExistingArticle | null, InfraError>(),
);

export const targetArticleExists = rule(previewArticle.decide, {
  name: "対象の記事が存在する",
  requires: { findArticle },
  when: always,
  check: async ({ input }, { findArticle }) => {
    const article = await findArticle(input.blogId, input.articleId);
    return article ? Result.succeed({ article }) : Result.fail("ARTICLE_NOT_FOUND");
  },
});

export const notArchived = rule(previewArticle.decide.with<{ article: ExistingArticle }>(), {
  name: "アーカイブ済みの記事はプレビューできない",
  when: always,
  check: ({ article }) => (article.status !== "ARCHIVED" ? Result.succeed() : Result.fail("ARCHIVED")),
});

export const canPreview = rule(previewArticle.decide.with<{ article: ExistingArticle }>(), {
  name: "プレビューできるのはメンバーの著者かレビュアーだけ",
  when: always,
  check: ({ actor, article }) => {
    if (!isMember(actor)) {
      return Result.fail("NOT_ALLOWED");
    }
    if (actor.id === article.authorId) {
      return Result.succeed({ viewerRole: "author" as const });
    }
    if (actor.id === article.reviewerId) {
      return Result.succeed({ viewerRole: "reviewer" as const });
    }
    return Result.fail("NOT_ALLOWED");
  },
});

export const previewArticleRules = actionRules(previewArticle, {
  rules: [targetArticleExists, notArchived, canPreview],
  output: ({ article, viewerRole }) => ({ article, viewerRole }),
});
