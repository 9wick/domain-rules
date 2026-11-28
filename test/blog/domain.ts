import { Result } from "@praha/byethrow";
import * as v from "valibot";
import {
  actionRules,
  always,
  and,
  cached,
  changed,
  defaultFields,
  domainDefinitionKit,
  emit,
  immutable,
  modelRules,
  next,
  not,
  onCreate,
  port,
  pre,
  rule,
  ruleset,
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

const { model, action, actor } = domainDefinitionKit<{ actor: AppActor }>();

export const ArticleIdSchema = v.pipe(v.string(), v.startsWith("art_"), v.brand("ArticleId"));
export const ArticleIdExistedSchema = v.pipe(ArticleIdSchema, v.brand("ArticleIdExisted"));
export const ArticleIdNewSchema = v.pipe(ArticleIdSchema, v.brand("ArticleIdNew"));
export type ArticleId = v.InferOutput<typeof ArticleIdSchema>;
export type ArticleIdExisted = v.InferOutput<typeof ArticleIdExistedSchema>;
export type ArticleIdNew = v.InferOutput<typeof ArticleIdNewSchema>;

export const ArticleStatusSchema = v.picklist(["DRAFT", "PUBLISHED", "ARCHIVED"]);
export type ArticleStatus = v.InferOutput<typeof ArticleStatusSchema>;

const articleKey = v.object({ id: v.optional(ArticleIdSchema) });
// status と approvedAt は作成時に省略でき、省略したときの値はルールで入れる
const articleValue = v.object({
  blogId: BlogIdSchema,
  status: v.optional(ArticleStatusSchema),
  authorId: UserIdSchema,
  reviewerId: UserIdSchema,
  slug: v.pipe(v.string(), v.minLength(1)),
  publishAt: v.pipe(v.number(), v.integer()),
  approvedAt: v.optional(v.nullable(v.number())),
});

export const article = model({
  name: "article",
  schema: {
    key: articleKey,
    value: articleValue,
    persisted: v.object({
      ...articleKey.entries,
      ...articleValue.entries,
      status: ArticleStatusSchema,
      approvedAt: v.nullable(v.number()),
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
export const requireExistingUser = port("requireExistingUser").of<
  (id: UserId) => UserIdExisted,
  "USER_NOT_FOUND" | InfraError
>();
export const findBlog = cached(port("findBlog").of<(id: BlogId) => Blog | null, InfraError>());
export const findArticlesInBlog = cached(
  port("findArticlesInBlog").of<(blogId: BlogId) => readonly ExistingArticle[], InfraError>(),
);
export const newArticleId = port("newArticleId").of<() => ArticleIdNew, InfraError>();

// 既定値を入れたあとの値。status と approvedAt を読むルールは、この状態を前提にする
type Defaulted = { readonly next: { readonly status: ArticleStatus; readonly approvedAt: number | null } };
const savedWithDefaults = article.onSave.assuming<Defaulted>();

export const articleDefaults = defaultFields(article.onSave, { status: "DRAFT", approvedAt: null });

export const isDraft = (a: ArticleValue) => a.status === "DRAFT";
export const isPublished = (a: ArticleValue) => a.status === "PUBLISHED";
export const isApproved = (a: ArticleValue) => a.approvedAt !== null;

export const authorIsNotReviewer = rule(article.onSave, {
  id: "reviewerIsNotAuthor",
  description: "著者とレビュアーは別の人",
  when: always,
  check: (s) => (s.next.authorId !== s.next.reviewerId ? Result.succeed() : Result.fail("SAME_AUTHOR_AND_REVIEWER")),
});

export const uniqueSlugInBlog = rule(article.onSave, {
  id: "uniqueSlug",
  description: "slug はブログ内で一意",
  requires: { findArticlesInBlog },
  when: changed("slug"),
  check: async (s, { findArticlesInBlog }) => {
    const articles = await findArticlesInBlog(s.next.blogId);
    if (Result.isFailure(articles)) return articles;
    return articles.value.some((a) => a.slug === s.next.slug && a.id !== s.pre?.id)
      ? Result.fail("DUPLICATED_SLUG")
      : Result.succeed();
  },
});

export const publishAtInFuture = rule(article.onSave, {
  id: "publishAtInFuture",
  description: "公開日時は未来",
  when: changed("publishAt"),
  check: (s) => (s.next.publishAt > s.now ? Result.succeed() : Result.fail("PUBLISH_AT_IN_PAST")),
});

export const onlyReviewerPublishes = rule(savedWithDefaults, {
  id: "publishByReviewer",
  description: "公開できるのは今のレビュアーだけ",
  when: changed("status", { pre: "DRAFT", next: "PUBLISHED" }),
  check: (s) => (s.actor.id === s.pre?.reviewerId ? Result.succeed() : Result.fail("NOT_REVIEWER")),
});

export const onlyAuthorChangesReviewer = rule(article.onSave, {
  id: "reviewerChangeByAuthor",
  description: "作成後にレビュアーを変えられるのは著者だけ",
  when: and(not(onCreate), changed("reviewerId")),
  check: (s) => (s.actor.id === s.pre?.authorId ? Result.succeed() : Result.fail("NOT_AUTHOR")),
});

export const slugLockedAfterPublish = rule(article.onSave, {
  id: "slugChangeAfterPublishByAdmin",
  description: "公開後の slug を変えられるのは管理者だけ",
  when: and(changed("slug"), pre(isPublished), not(actor(isAdmin))),
  check: () => Result.fail("SLUG_LOCKED"),
});

export const publishedIsApproved = rule(savedWithDefaults, {
  id: "publishedIsApproved",
  description: "公開中の記事は承認済み",
  when: next(isPublished),
  check: (s) => (isApproved(s.next) ? Result.succeed() : Result.fail("NOT_APPROVED")),
});

const allowedStatusChanges: Record<ArticleStatus, readonly ArticleStatus[]> = {
  DRAFT: ["DRAFT", "PUBLISHED"],
  PUBLISHED: ["PUBLISHED", "ARCHIVED"],
  ARCHIVED: ["ARCHIVED"],
};

export const statusChangesAreAllowed = rule(savedWithDefaults, {
  id: "allowedStatusTransition",
  description: "status は許可された変化だけ",
  when: changed("status"),
  check: (s) => {
    const allowed = s.pre === null ? ["DRAFT"] : allowedStatusChanges[s.pre.status];
    return allowed.includes(s.next.status) ? Result.succeed() : Result.fail("STATUS_CHANGE_NOT_ALLOWED");
  },
});

export const onlyDraftIsDeletable = rule(article.onDelete, {
  id: "deleteOnlyDraft",
  description: "削除できるのは下書きだけ",
  when: not(pre(isDraft)),
  check: () => Result.fail("NOT_DRAFT"),
});

export const articleImmutableFields = immutable(article.onSave, ["blogId", "authorId"]);

export const reviewerExists = rule(article.onSave, {
  id: "reviewerExists",
  description: "レビュアーが存在する",
  requires: { requireExistingUser },
  when: always,
  check: async ({ pre, next }, { requireExistingUser }) => {
    if (pre && pre.reviewerId === next.reviewerId) {
      return Result.succeed({ next: { reviewerId: pre.reviewerId } });
    }
    const reviewerId = await requireExistingUser(next.reviewerId);
    if (Result.isFailure(reviewerId)) return reviewerId;
    return Result.succeed({ next: { reviewerId: reviewerId.value } });
  },
});

export const blogExists = rule(article.onSave, {
  id: "blogExists",
  description: "ブログが存在する",
  requires: { findBlog },
  when: always,
  // port の Result を if で取り出す代わりに、safeTry の中で yield* で取り出す書き方
  check: ({ pre, next }, _, { safeTry }) =>
    safeTry(async function* ({ findBlog }) {
      if (pre && pre.blogId === next.blogId) {
        return Result.succeed({ next: { blogId: pre.blogId } });
      }
      const blog = yield* findBlog(next.blogId);
      return blog ? Result.succeed({ next: { blogId: blog.id } }) : Result.fail("BLOG_NOT_FOUND");
    }),
});

export const blogAcceptsPosts = rule(article.onSave.assuming<Defaulted & { next: { blogId: BlogIdExisted } }>(), {
  id: "blogAcceptsPosts",
  description: "投稿を受け付けているブログ",
  requires: { findBlog },
  when: changed("status", { next: "PUBLISHED" }),
  check: async ({ next }, { findBlog }) => {
    const blog = await findBlog(next.blogId);
    if (Result.isFailure(blog)) return blog;
    return blog.value?.acceptsPosts === true ? Result.succeed() : Result.fail("BLOG_CLOSED");
  },
});

export const existingArticleId = rule(article.onSave, {
  id: "keepExistingId",
  description: "既存の記事の id",
  when: always,
  check: ({ pre }) => Result.succeed({ next: { id: pre?.id } }),
});

export const articleIdAssigned = rule(article.onSave.assuming<{ next: { id: Article["id"] | undefined } }>(), {
  id: "assignNewId",
  description: "新しい記事に id を付ける",
  requires: { newArticleId },
  when: always,
  check: async ({ next }, { newArticleId }) => {
    if (next.id !== undefined) return Result.succeed({ next: { id: next.id } });
    const id = await newArticleId();
    if (Result.isFailure(id)) return id;
    return Result.succeed({ next: { id: id.value } });
  },
});

// 公開されたことをレビュアーに知らせる。宛先のアドレスは配送する側が reviewerId から引く
export const articlePublished = emit(
  savedWithDefaults.assuming<{ next: { id: Article["id"]; reviewerId: UserIdExisted } }>(),
  {
    id: "articlePublished",
    description: "公開されたらレビュアーに知らせる",
    when: changed("status", { pre: "DRAFT", next: "PUBLISHED" }),
    event: (s) =>
      ({
        type: "ARTICLE_PUBLISHED",
        articleId: s.next.id,
        reviewerId: s.next.reviewerId,
        publishedBy: s.actor.id,
      }) as const,
  },
);

export const articleDeleted = emit(article.onDelete, {
  id: "articleDeleted",
  description: "削除されたら著者に知らせる",
  when: always,
  event: (s) => ({ type: "ARTICLE_DELETED", articleId: s.pre.id, authorId: s.pre.authorId }) as const,
});

export const isMember = (a: AppActor): a is MemberActor => a.role === "MEMBER" || a.role === "ADMIN";

const memberOnly = {
  id: "memberOnly" as const,
  description: "記事を変更できるのはメンバーだけ",
  when: always,
  check: ({ actor }: { actor: AppActor }) => (isMember(actor) ? Result.succeed({ actor }) : Result.fail("NOT_MEMBER")),
};

export const memberCanSave = rule(article.onSave, memberOnly);
export const memberCanDelete = rule(article.onDelete, memberOnly);

export const articleRules = modelRules(article)
  .load({
    requires: { findArticleById },
    fetch: async ({ input }, { findArticleById }) => {
      const found = await findArticleById(input.id);
      if (Result.isFailure(found)) return found;
      return found.value ? Result.succeed(found.value) : Result.fail("ARTICLE_NOT_FOUND");
    },
  })
  .save(
    ruleset(memberCanSave)
      .add(articleDefaults)
      .add(statusChangesAreAllowed)
      .add(articleImmutableFields)
      .add(blogExists)
      .add(reviewerExists)
      .add(authorIsNotReviewer)
      .add(uniqueSlugInBlog)
      .add(publishAtInFuture)
      .add(onlyReviewerPublishes)
      .add(onlyAuthorChangesReviewer)
      .add(slugLockedAfterPublish)
      .add(publishedIsApproved)
      .add(blogAcceptsPosts)
      .add(existingArticleId)
      .add(articleIdAssigned)
      .add(articlePublished),
  )
  .delete(ruleset(memberCanDelete).add(onlyDraftIsDeletable).add(articleDeleted));

export const previewArticle = action({
  name: "previewArticle",
  input: v.object({ blogId: BlogIdSchema, articleId: ArticleIdSchema }),
});

export const findArticle = cached(
  port("findArticle").of<(blogId: BlogId, id: ArticleId) => ExistingArticle | null, InfraError>(),
);

export const targetArticleExists = rule(previewArticle.onDecide, {
  id: "articleExists",
  description: "対象の記事が存在する",
  requires: { findArticle },
  when: always,
  check: async ({ input }, { findArticle }) => {
    const article = await findArticle(input.blogId, input.articleId);
    if (Result.isFailure(article)) return article;
    return article.value ? Result.succeed({ article: article.value }) : Result.fail("ARTICLE_NOT_FOUND");
  },
});

export const notArchived = rule(previewArticle.onDecide.assuming<{ article: ExistingArticle }>(), {
  id: "noPreviewWhenArchived",
  description: "アーカイブ済みの記事はプレビューできない",
  when: always,
  check: ({ article }) => (article.status !== "ARCHIVED" ? Result.succeed() : Result.fail("ARCHIVED")),
});

export const canPreview = rule(previewArticle.onDecide.assuming<{ article: ExistingArticle }>(), {
  id: "previewByAuthorOrReviewer",
  description: "プレビューできるのはメンバーの著者かレビュアーだけ",
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
  rules: ruleset(targetArticleExists).add(notArchived).add(canPreview),
  output: ({ article, viewerRole }) => ({ article, viewerRole }),
});
