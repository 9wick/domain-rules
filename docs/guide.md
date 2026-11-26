# 利用ガイド

このガイドでは、ブログ記事ドメイン（[test/blog/domain.ts](../test/blog/domain.ts)）を題材に、`domain-rules` の各 API の使い方を順を追って説明します。

## 目次

- [ドメインを定義する道具を受け取る (`domainDefinitionKit`)](#ドメインを定義する道具を受け取る-domaindefinitionkit)
- [モデルを定義する (`model`)](#モデルを定義する-model)
- [操作フェーズと状態型 (`onSave` / `onDelete` / `onDecide`)](#操作フェーズと状態型-onsave--ondelete--ondecide)
- [外部依存を宣言する (`port` / `cached`)](#外部依存を宣言する-port--cached)
- [ルールを定義する (`rule`)](#ルールを定義する-rule)
- [適用条件を書く (`when`)](#適用条件を書く-when)
- [確認済みの値で型を昇格させる](#確認済みの値で型を昇格させる)
- [モデルのルール定義を組み立てる (`modelRules`)](#モデルのルール定義を組み立てる-modelrules)
- [永続化を伴わない操作を定義する (`action` / `actionRules`)](#永続化を伴わない操作を定義する-action--actionrules)
- [実装を注入する (`provide` / `bind`) とテスト](#実装を注入する-provide--bind-とテスト)
- [実行時の挙動と失敗の型 (`create` / `update` / `delete` / `decide`)](#実行時の挙動と失敗の型-create--update--delete--decide)
- [検証済みの値を取り出す (`open`)](#検証済みの値を取り出す-open)
- [ルール構成を確認する (`plan`)](#ルール構成を確認する-plan)

---

## ドメインを定義する道具を受け取る (`domainDefinitionKit`)

`domainDefinitionKit` は、メソッドを呼ぶ操作者 (`actor`) の型を 1 回だけ決め、その型を使う `model` / `action` / `actor` を返します。各線路の状態の `actor`、メソッドの引数の `actor`、`Persistable` などの既定の `actor` の型は、すべてここで決めた型になります。`actor` の型を model や rule ごとに書く必要はありません。

```ts
import { domainDefinitionKit } from "domain-rules";

export type AppActor = { readonly id: UserId; readonly role: "GUEST" | "MEMBER" | "ADMIN" };

export const { model, action, actor } = domainDefinitionKit<{ actor: AppActor }>();
```

返すのは domain を定義するための道具で、domain そのものではありません。domain 層へのアクセス obj は、定義を [`bind`](#実装を注入する-provide--bind-とテスト) に渡して作ります。グローバルな型の登録は使わないので、1 つのアプリケーションの中で `actor` の型が違うドメインを複数定義できます。

---

## モデルを定義する (`model`)

`model` は、検証対象の入力スキーマと永続化後のスキーマを定義します。`domainDefinitionKit` が返した `model` を使います。

```ts
import * as v from "valibot";
import type { Persisted, Value } from "domain-rules";

export const ArticleIdSchema = v.pipe(v.string(), v.startsWith("art_"), v.brand("ArticleId"));
export const ArticleIdExistedSchema = v.pipe(ArticleIdSchema, v.brand("ArticleIdExisted"));
export const ArticleIdNewSchema = v.pipe(ArticleIdSchema, v.brand("ArticleIdNew"));

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

export type ArticleValue = Value<typeof article>; // schema.input の出力型
export type Article = Persisted<typeof article>; // schema.persisted の出力型
export type ExistingArticle = Omit<Article, "id"> & { id: ArticleIdExisted }; // DB から読んだ記事の型
```

- **`schema.input`**: 入力データのスキーマです。更新時は入力に含まれたフィールドだけを個別に検証するため、トップレベルが `entries` を持つオブジェクトスキーマ（Valibot の `v.object` 等）である必要があります。そのため、オブジェクト全体に付けたクロスフィールド検証は使われません。複数フィールドにまたがる条件（「著者とレビュアーは別人」など）はルールとして書きます。
- **`schema.persisted`**: 永続化時の型を決めるためのスキーマです。`input` より強い型（存在確認済み Brand 型など）を持たせられます。ライブラリはこのスキーマで実行時の検証を行いません（未確認の入力に Brand が付くのを防ぐため）。保存パイプラインの終端で `next` がこの型になっていることをコンパイル時に検査します。
- **新規作成時の既定値**: `schema.input` 内の `v.optional` の既定値は、`create` 時にだけ適用されます。
- **`id` の扱い**: `model` 自身は `id` の取得や採番を行いません。既存レコードの取得は `modelRules(...).load({ requires, fetch })` に書き、新規 ID の採番も他のフィールドと同様にルールで型を昇格させます。なお、更新・削除・upsert を使うモデルの `schema.input` では `id` を省略可能にしておく必要があります。

---

## 操作フェーズと状態型 (`onSave` / `onDelete` / `onDecide`)

ルールを定義するときは、第 1 引数に「どの対象・どの操作フェーズのルールか」を表す値を渡します。パイプラインを流れる初期状態の型はフェーズごとに異なります。

| 操作フェーズ     | 指定する値                | 初期状態の型                                               |
| ---------------- | ------------------------- | ---------------------------------------------------------- |
| モデルの保存     | `article.onSave`          | `{ pre: Article \| null, next: ArticleValue, actor, now }` |
| モデルの削除     | `article.onDelete`        | `{ pre: Article, next: null, actor, now }`                 |
| アクションの判定 | `previewArticle.onDecide` | `{ input, actor, now }`                                    |

- **`pre`**: DB から読み込んだ既存の値（`load` の `fetch` が成功として返した値）。新規作成時は `null` です。ルール定義時点では `load` が未定のため、`pre` の型は `Persisted<M>` になります。`fetch` のより具体的な返り値型（例: `ExistingArticle`）を前提としたい場合は `.assuming<...>()` を付け、パイプラインの先頭に配置します（開始状態がその型を満たすかを `modelRules` が検査します）。
- **`next`**: 変更後の値。更新時は既存値に入力値をマージしたオブジェクトです（型は `ArticleValue` ですが、入力で省略されたフィールドには既存値が引き継がれます）。
- **`now`**: 呼び出し開始時の時刻（`clock` プロバイダーが返す数値）。1 回の実行中は固定値です。

### 前段ルールの型昇格を前提にする (`assuming`)

前のステップで型が絞り込まれた状態を前提にするルールは、`.assuming<...>()` で前提型を追加します。

```ts
article.onSave.assuming<{ next: { reviewerId: UserIdExisted } }>();
```

`ruleset.add(...)` の際、前段までのステップでその型を満たしていなければコンパイルエラーになります。

> **なぜ型引数ではなく値 (`article.onSave`) で渡すのか**: TypeScript では型引数の一部だけを明示して残りを推論できないためです。値で渡すことで、状態の型と `requires` の型を両方とも引数から自然に推論できます。

---

## 外部依存を宣言する (`port` / `cached`)

`port` は `check` から呼び出す外部機能（リポジトリ参照や ID 採番など）のインターフェース宣言です。引数・返り値・エラーの型だけを持ち、実装は持ちません。

```ts
import { port, cached } from "domain-rules";

// 既存の記事を取得する（modelRules の load の fetch から呼ぶ）
export const findArticleById = port("findArticleById").of<(id: ArticleId) => ExistingArticle | null, InfraError>();

// 存在確認できれば、存在確認済みの型として同じ ID を返す
export const requireExistingUser = port("requireExistingUser").of<
  (id: UserId) => UserIdExisted,
  "USER_NOT_FOUND" | InfraError
>();

// cached を付けると、1 回の実行内で同じ引数の呼び出し結果をキャッシュする
export const findBlog = cached(port("findBlog").of<(id: BlogId) => Blog | null, InfraError>());

export const findArticlesInBlog = cached(
  port("findArticlesInBlog").of<(blogId: BlogId) => readonly ExistingArticle[], InfraError>(),
);

export const newArticleId = port("newArticleId").of<() => ArticleIdNew, InfraError>();
```

- `port` は特定のモデルやフェーズに紐づかないため、保存・削除・アクションのどのルールからも呼び出せます。
- **オンデマンド取得**: データの取得は `check` が `port` を呼び出したタイミングでのみ行われます。ライブラリが先回りして一括取得することはありません。
- `check` の中では `await findBlog(id)` のように呼び出し、`Result<Blog | null, InfraError>` が返ります。エラーをそのままルールの失敗にするか、別のエラー型に変換するかは `check` 側で制御します。
- **`cached(p)` とキャッシュ方針**: `cached(p)` でラップすると、1 回のメソッド実行中に同じ引数（`JSON.stringify` で比較）で 2 回目以降呼ばれたとき、実処理を実行せず 1 回目の結果を再利用します。ドメインルールは最新の状態で検証する前提のため、リクエストをまたぐキャッシュは行わず、実行終了とともに破棄されます（異なる引数をまとめるバッチ化は未実装です。[未決定の論点](design.md#未決定の論点) 参照）。

---

## ルールを定義する (`rule`)

`rule` はパイプラインの 1 ステップを定義します。外部ポートを使う場合は `requires` に指定し、`check` の第 2 引数から受け取ります(第 3 引数の [`safeTry`](#port-の結果を-yield-で取り出す-safetry) でも受け取れます)。

```ts
import { rule, always, onCreate, changed, next, pre, and, not } from "domain-rules";
// actor は domainDefinitionKit が返したもの。述語はその actor の型を受け取る
import { Result } from "@praha/byethrow";

export const authorIsNotReviewer = rule(article.onSave, {
  name: "著者とレビュアーは別の人",
  when: always,
  check: (s) => (s.next.authorId !== s.next.reviewerId ? Result.succeed() : Result.fail("SAME_AUTHOR_AND_REVIEWER")),
});

export const uniqueSlugInBlog = rule(article.onSave, {
  name: "slug はブログ内で一意",
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

export const onlyReviewerPublishes = rule(article.onSave, {
  name: "公開できるのは今のレビュアーだけ",
  when: changed("status", { pre: "DRAFT", next: "PUBLISHED" }),
  check: (s) => (s.actor.id === s.pre?.reviewerId ? Result.succeed() : Result.fail("NOT_REVIEWER")),
});

export const onlyDraftIsDeletable = rule(article.onDelete, {
  name: "削除できるのは下書きだけ",
  when: not(pre(isDraft)),
  check: () => Result.fail("NOT_DRAFT"),
});
```

### port の結果を `yield*` で取り出す (`safeTry`)

port の `Result` を `if (Result.isFailure(...)) return ...` で毎回取り出す代わりに、`check` の第 3 引数の `safeTry` を使って書くこともできます。どちらの書き方を使ってもかまいません。

```ts
export const uniqueSlugInBlog = rule(article.onSave, {
  name: "slug はブログ内で一意",
  requires: { findArticlesInBlog },
  when: changed("slug"),
  check: (s, _, { safeTry }) =>
    safeTry(async function* ({ findArticlesInBlog }) {
      const articles = yield* findArticlesInBlog(s.next.blogId);
      return articles.some((a) => a.slug === s.next.slug && a.id !== s.pre?.id)
        ? Result.fail("DUPLICATED_SLUG")
        : Result.succeed();
    }),
});
```

- `safeTry` の関数は `requires` に書いた port を受け取ります。`yield*` に渡すと、成功なら値を返し、失敗ならそこで止まってその失敗が `check` の結果になります。
- 失敗の型は、`yield*` した port の失敗と、最後に返した `Result` の失敗を合わせたものになります。
- 失敗で止まるときは generator を閉じるので、関数の中の `finally` や `using` の後始末は走ります。

### 組み込みヘルパー (`immutable` / `alwaysAllow`)

よく使われるパターンのヘルパーが用意されています。

```ts
import { immutable } from "domain-rules";

// 作成後に変更不可なフィールドを禁止する
export const articleImmutableFields = immutable(article.onSave, ["blogId", "authorId"]);
```

`immutable` が返すルールの名前は `"作成後に変えられない項目: blogId, authorId"` になり、更新時に該当フィールドが変わると `{ code: "IMMUTABLE_FIELD_CHANGED", field: "blogId" }` で失敗します。

条件なしで削除を許可するモデルには、`.delete(ruleset(alwaysAllow))` を指定できます。

> **ルール定義オブジェクトを変数に切り出すときの注意**:
> `const def = { name: "..." as const, ... }` のようにオブジェクトリテラルを別の変数に置いて `rule()` へ渡す場合は、`name` に `as const` を付けてください。付けないと `name` の型が `string` に広がり、失敗型の `step` がリテラル型で判別できなくなります（`rule()` にインラインで渡す場合は不要です）。

---

## 適用条件を書く (`when`)

`domain-rules` 自体は「状態遷移」という特別機能を持たず、状態判定は通常の述語関数として表現します。

```ts
export const isDraft = (a: ArticleValue) => a.status === "DRAFT";
export const isPublished = (a: ArticleValue) => a.status === "PUBLISHED";
export const isApproved = (a: ArticleValue) => a.approvedAt !== null;
```

### 組み込みの `when` ビルダー

| 用途                                                         | 書き方                                                                                | 利用できるフェーズ   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------- |
| 常に適用する                                                 | `always`                                                                              | すべて               |
| 新規作成時のみ                                               | `onCreate`                                                                            | `onSave`             |
| フィールドが変化したとき（新規作成時も含む）                 | `changed("slug")`                                                                     | `onSave`             |
| 指定値から別の値へ変化したとき（新規作成時は除外）           | `changed("status", { pre: "DRAFT" })`                                                 | `onSave`             |
| 指定値へ変化したとき（新規作成時にその値で始まる場合も含む） | `changed("status", { next: "PUBLISHED" })`                                            | `onSave`             |
| 指定値から指定値へ変化したとき                               | `changed("status", { pre: "DRAFT", next: "PUBLISHED" })`                              | `onSave`             |
| 変更後の値が述語を満たすとき                                 | `next(isPublished)`                                                                   | `onSave`             |
| 既存の値が述語を満たすとき（新規作成時は除外）               | `pre(isDraft)`                                                                        | `onSave`, `onDelete` |
| 操作者 (`actor`) が述語を満たすとき                          | `actor(isAdmin)`、`actor((a, s: { next: ArticleValue }) => a.id === s.next.authorId)` | すべて               |
| 論理演算での合成                                             | `and(...)`、`or(...)`、`not(...)`                                                     | すべて               |
| カスタム条件関数                                             | `(s) => boolean`                                                                      | すべて               |

- 使えないフェーズや存在しないフィールド名を指定すると、コンパイルエラーになります。
- `actor` 述語の第 2 引数（状態 `s`）は型推論できないため、参照する場合は上記のように型注釈を書きます。
- `changed` の変化判定および `immutable` の比較は `Object.is` で行います。配列やオブジェクトのフィールドは、中身が同じでも別参照なら「変化した」とみなされます。複数フィールドにまたがる条件は `pre(述語)` と `next(述語)` を `and` 等で組み合わせてください。
- `when` には `{ kind: "changed", ... }` のようなメタデータが付与され、`plan()` で構造を可視化できます。手書きの関数にも `describe("公開済みの記事", (s) => ...)` で説明を付けられます。

### `actor` 条件は `when` と `check` のどちらに書くか

- **対象者によってルール自体の適用有無が変わる場合** → `when` に書く（例: 「管理者以外は公開後の `slug` を変更不可」では、管理者に対してはルール自体をスキップする）
- **特定のイベント時に権限不足をエラーとして返したい場合** → `check` に書く（例: 「公開操作時に今のレビュアーでなければエラー」）

---

## 確認済みの値で型を昇格させる

`check` が `Result.succeed(patch)` の形でオブジェクトを返すと、その内容が状態にマージされ、以降のステップではより狭い型（交差型）として扱われます。`next` のフィールドや `actor` を絞り込んだり、新しいプロパティを状態に追加したりできます。

- **安全性の制約**: `next` のフィールドや `actor` を更新する場合、置換後の型は元の型の**部分型（より狭い型）**でなければなりません。無関係な型への置き換えや、一度狭めた型と矛盾する型への変更は、`ruleset.add()` 時にコンパイルエラーになります。値の形式変換は入力スキーマ側で行ってください。

```ts
export const reviewerExists = rule(article.onSave, {
  name: "レビュアーが存在する",
  requires: { requireExistingUser },
  when: always,
  check: async ({ pre, next }, { requireExistingUser }) => {
    // 既存の値は確認済みなので、変更されていなければ再取得しない
    if (pre && pre.reviewerId === next.reviewerId) {
      return Result.succeed({ next: { reviewerId: pre.reviewerId } });
    }
    const reviewerId = await requireExistingUser(next.reviewerId);
    if (Result.isFailure(reviewerId)) return reviewerId;
    return Result.succeed({ next: { reviewerId: reviewerId.value } });
  },
});

export const blogExists = rule(article.onSave, {
  name: "ブログが存在する",
  requires: { findBlog },
  when: always,
  check: async ({ pre, next }, { findBlog }) => {
    if (pre && pre.blogId === next.blogId) {
      return Result.succeed({ next: { blogId: pre.blogId } });
    }
    const blog = await findBlog(next.blogId);
    if (Result.isFailure(blog)) return blog;
    return blog.value ? Result.succeed({ next: { blogId: blog.value.id } }) : Result.fail("BLOG_NOT_FOUND");
  },
});

// 前段の blogExists で blogId が BlogIdExisted に昇格していることを前提にする
export const blogAcceptsPosts = rule(article.onSave.assuming<{ next: { blogId: BlogIdExisted } }>(), {
  name: "投稿を受け付けているブログ",
  requires: { findBlog },
  when: changed("status", { next: "PUBLISHED" }),
  check: async ({ next }, { findBlog }) => {
    const blog = await findBlog(next.blogId);
    if (Result.isFailure(blog)) return blog;
    return blog.value?.acceptsPosts ? Result.succeed() : Result.fail("BLOG_CLOSED");
  },
});
```

> **注意 (`always` 以外の `when` による昇格)**:
> `when` が `always` でない場合、条件に一致せずスキップされる可能性があるため、そのルールを通過した後の型は「昇格した型 | 昇格前の型」のユニオン型になります。`next.id` のように最終的に必ず確定させたいフィールドは、`when: always` のルール内の分岐で確定させるのが定石です。

### `id` と `actor` の昇格例

```ts
// 既存記事なら既存の id を引き継ぐ
export const existingArticleId = rule(article.onSave, {
  name: "既存の記事の id",
  when: always,
  check: ({ pre }) => Result.succeed({ next: { id: pre?.id } }),
});

// 未確定（新規作成）なら採番ポートから id を発行する
export const articleIdAssigned = rule(article.onSave.assuming<{ next: { id: Article["id"] | undefined } }>(), {
  name: "新しい記事に id を付ける",
  requires: { newArticleId },
  when: always,
  check: async ({ next }, { newArticleId }) => {
    if (next.id !== undefined) return Result.succeed({ next: { id: next.id } });
    const id = await newArticleId();
    if (Result.isFailure(id)) return id;
    return Result.succeed({ next: { id: id.value } });
  },
});

// actor の昇格（型述語で絞り込む）
export const isMember = (actor: AppActor): actor is MemberActor => actor.role === "MEMBER" || actor.role === "ADMIN";

const memberOnly = {
  name: "記事を変更できるのはメンバーだけ" as const,
  when: always,
  check: ({ actor }: { actor: AppActor }) => (isMember(actor) ? Result.succeed({ actor }) : Result.fail("NOT_MEMBER")),
};

export const memberCanSave = rule(article.onSave, memberOnly);
export const memberCanDelete = rule(article.onDelete, memberOnly);
```

---

## モデルのルール定義を組み立てる (`modelRules`)

モデルごとに 1 つの `modelRules` を定義します。保存と削除のパイプラインは `ruleset(firstRule).add(nextRule)...` で構築します。`add` は元の `ruleset` を変更せず新しいインスタンスを返します。

```ts
import { modelRules, ruleset } from "domain-rules";

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
      .add(articleIdAssigned),
  )
  .delete(ruleset(memberCanDelete).add(onlyDraftIsDeletable));
```

- **`.load({ requires, fetch })`**: 既存の値を取得するステップを定義します。`update` / `upsert` / `delete` メソッドを生成するために必要で、`save` / `delete` より前に呼び出します。`fetch` はルールの `check` と同じく `requires` に書いたポートを受け取り、`Result` を返します。第 1 引数は `{ input, actor }` で、`input` は検証済みの入力（`id` は必ず入ります）、`actor` はメソッドに渡された操作者です。`id` 以外の値（`actor` のテナント ID など）も取得条件に使えます。成功の値は `schema.persisted` と `schema.input` の両方の出力型に代入可能である必要があり、そのまま `pre` になります。ライブラリは成功の値も失敗の値も解釈しません。見つからなかったときの失敗は、`fetch` が自分で返します。
- **`.save(ruleset)`**: `create` を生成します（`.load()` の後に書くと `update` と `upsert` も生成されます）。保存パイプラインの終端で `next` が `schema.persisted` の型を満たしていないとコンパイルエラーになります。
- **`.delete(ruleset)`**: `.load()` の後にだけ指定でき、`delete` を生成します。指定しなければ削除メソッドは生えません。

### `actor` 型

`actor` の型は [`domainDefinitionKit`](#ドメインを定義する道具を受け取る-domaindefinitionkit) で決めます。`model` がその `actor` の型を持つので、`modelRules` が作るメソッドの引数と各 rule の状態の `actor` は、何も書かなくてもその型になります。

---

## 永続化を伴わない操作を定義する (`action` / `actionRules`)

プレビュー閲覧やダウンロード可否判定など、DB への保存を伴わない操作は `action` として定義します。`action` の入力スキーマは任意の Standard Schema 準拠スキーマが使えます。

```ts
import { actionRules, cached, port, rule, ruleset, always } from "domain-rules";
// action は domainDefinitionKit が返したもの

export const previewArticle = action({
  name: "previewArticle",
  input: v.object({ blogId: BlogIdSchema, articleId: ArticleIdSchema }),
});

export const findArticle = cached(
  port("findArticle").of<(blogId: BlogId, id: ArticleId) => ExistingArticle | null, InfraError>(),
);

export const targetArticleExists = rule(previewArticle.onDecide, {
  name: "対象の記事が存在する",
  requires: { findArticle },
  when: always,
  check: async ({ input }, { findArticle }) => {
    const article = await findArticle(input.blogId, input.articleId);
    if (Result.isFailure(article)) return article;
    return article.value ? Result.succeed({ article: article.value }) : Result.fail("ARTICLE_NOT_FOUND");
  },
});

export const notArchived = rule(previewArticle.onDecide.assuming<{ article: ExistingArticle }>(), {
  name: "アーカイブ済みの記事はプレビューできない",
  when: always,
  check: ({ article }) => (article.status !== "ARCHIVED" ? Result.succeed() : Result.fail("ARCHIVED")),
});

export const canPreview = rule(previewArticle.onDecide.assuming<{ article: ExistingArticle }>(), {
  name: "プレビューできるのはメンバーの著者かレビュアーだけ",
  when: always,
  check: ({ actor, article }) => {
    if (!isMember(actor)) return Result.fail("NOT_ALLOWED");
    if (actor.id === article.authorId) return Result.succeed({ viewerRole: "author" as const });
    if (actor.id === article.reviewerId) return Result.succeed({ viewerRole: "reviewer" as const });
    return Result.fail("NOT_ALLOWED");
  },
});

export const previewArticleRules = actionRules(previewArticle, {
  rules: ruleset(targetArticleExists).add(notArchived).add(canPreview),
  output: ({ article, viewerRole }) => ({ article, viewerRole }),
});
```

`output` には最後の状態を受け取って結果を組み立てる関数を渡します（返り値不要なら `output: () => undefined`）。

---

## 実装を注入する (`provide` / `bind`) とテスト

`provide` で各 `port`（および `clock`）に実装を与え、`bind` でルール定義と結合して実行用オブジェクトを生成します。

```ts
import { provide, bind, clock } from "domain-rules";

export const providers = [
  provide(findArticleById, (id) => articleRepository.findById(id)),
  provide(newArticleId, () => createArticleId()),
  provide(requireExistingUser, (id) => userRepository.requireExisting(id)),
  provide(findBlog, (id) => blogRepository.findById(id)),
  provide(findArticlesInBlog, (blogId) => articleRepository.findByBlog(blogId)),
  provide(findArticle, (blogId, id) => articleRepository.find(blogId, id)),
  provide(clock, () => Date.now()),
] as const;

export const domain = bind([articleRules, previewArticleRules], { providers });
// {
//   article: { create, update, upsert, delete },
//   previewArticle: { decide },
// }
```

- `providers` を変数に置く場合は、ポート名が `string` に広がるのを防ぐため `as const` を付けてください（配列リテラルを直接 `bind` に渡す場合は不要です）。
- **型チェックと起動時チェック**: 必要なプロバイダーの不足はコンパイル時に型エラーになります。また、実行時にも `bind` 内で重複するモデル／アクション名やプロバイダーの不足・重複を検査します（`cached(p)` は元の `p` と同じポートとして照合されます）。

### テストでの利用

テストでは `provide.value` で固定値を渡すだけで済むため、リポジトリのモックフレームワークは不要です。

```ts
const testDomain = bind([articleRules], {
  providers: [
    provide.value(findArticleById, existingArticle),
    provide.value(newArticleId, ArticleIdNewSchema.parse("art_1")),
    provide.value(requireExistingUser, UserIdExistedSchema.parse("usr_1")),
    provide.value(findBlog, openBlog),
    provide.value(findArticlesInBlog, []),
    provide.value(clock, 1_700_000_000_000),
  ],
});
```

---

## 実行時の挙動と失敗の型 (`create` / `update` / `delete` / `decide`)

ユースケース層では `bind` が生成したメソッドを呼び出すだけです。

```ts
const saved = await Result.pipe(
  domain.article.update({ input: { id: articleId, status: "PUBLISHED" }, actor }),
  Result.andThen((persistable) => repository.save(persistable)),
);
```

### メソッド一覧と返り値

| メソッド | 引数                                      | 成功時の返り値                         |
| -------- | ----------------------------------------- | -------------------------------------- |
| `create` | `{ input, actor }`（`id` は受け付けない） | `Persistable<M, "create">`             |
| `update` | `{ input, actor }`（`input.id` 必須）     | `Persistable<M, "update">`             |
| `upsert` | `{ input, actor }`                        | `Persistable<M, "create" \| "update">` |
| `delete` | `{ input: { id }, actor }`                | `Deletable<M>`                         |
| `decide` | `{ input, actor }`                        | `Decision<A, T>`                       |

`upsert` は `input.id` が無ければ新規作成、あれば `load` の `fetch` で既存値を取得して更新します。`fetch` が失敗を返せば `load` で失敗します。

### 実行ステップ

メソッドが呼ばれると、以下のステップを上から順に実行します。すべて `Result` を返し、失敗した時点で処理を中断します。

| 順  | ステップ          | 内容                                                                         | 失敗時の `error`                       |
| --- | ----------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| 1   | `input`           | 入力値をスキーマで検証・変換する                                             | `{ issues: StandardSchemaV1.Issue[] }` |
| 2   | `load`            | `modelRules(...).load({ requires, fetch })` で既存データを取得する           | `fetch` が返した失敗の値               |
| 3   | `merge`           | 既存データに検証済み入力をマージして `next` を作る                           | なし                                   |
| 4   | `rule`            | `ruleset` に並べたルールを順に評価・実行する                                 | 失敗したルールの `check` が返した値    |
| 5   | `seal` / `output` | 保存・削除は検証済みラッパーを生成。アクションは `output` で結果を組み立てる | なし                                   |

- **`create`**: `load` をスキップします（`pre` は `null`）。`input` ではスキーマ全体で検証し、省略可能項目の既定値を補完します。`id` やスキーマにない未知のキーがあると失敗します。
- **`update`**: 全 5 ステップを実行します。`input` では入力に含まれたキーだけを各フィールドのスキーマで検証します（未知のキーがあれば失敗します）。
- **`upsert`**: `input.id` が `undefined` なら `create`、指定されていれば `update` と同じステップを実行します。
- **`delete`**: `merge` をスキップします（`next` は `null`）。`input` では `id` のみを検証します。
- **`decide`**: `load` と `merge` をスキップします。`input` ではアクションの入力スキーマ全体で検証します。

### マージ (`merge`) とルール評価の仕様

- **`merge`（`update` 時）**: 入力で値が `undefined`（未指定）のフィールドは既存値 `pre` をそのまま引き継ぎ（永続化型を維持）、`null` のフィールドは `null` で上書きします。既存値 `pre` の再検証は行いません。マージ対象はトップレベルのフィールド（1 段目）のみです。
- **`rule` の評価**: 各ルールは直前の状態を受け取り、まず同期関数 `when` を評価します。`false` なら `check` をスキップして状態をそのまま次へ渡し、`true` なら `check` を実行します。`Result.succeed(patch)` なら `patch` を状態にマージ（`next` はフィールド単位でマージ）して次へ進み、`Result.fail(err)` ならそこで停止します。

### 失敗の型 (`Failure`)

失敗時は、どのステップで失敗したかを表す `step` と固有の `error` を持つ判別可能なユニオン型が返ります。

```ts
type Failure =
  | { step: "input"; error: { issues: StandardSchemaV1.Issue[] } }
  | { step: "load"; error: "ARTICLE_NOT_FOUND" | InfraError }
  | { step: "著者とレビュアーは別の人"; error: "SAME_AUTHOR_AND_REVIEWER" }
  | { step: "レビュアーが存在する"; error: "USER_NOT_FOUND" | InfraError }
  | ...;
```

- ライブラリが失敗の分類（NotFound / Conflict / Infra など）を強制することはなく、ルール固有のエラー表現は自由に定義できます。
- ルール内で呼んだ `port` が失敗を返した場合でも、`check` がその失敗を返したときにのみルールの失敗になります（`check` 内でリカバリーや別の失敗値への変換が可能です）。

---

## 検証済みの値を取り出す (`open`)

`Persistable` / `Deletable` / `Decision` は、パイプラインを通過したことを証明する不透明（opaque）なオブジェクトです。中身は `open()` でのみ取り出せます。

```ts
import { open } from "domain-rules";

const save = (p: Persistable<typeof article, "create" | "update">) => {
  const { pre, next, actor } = open(p);
  // pre: Readonly<Article> | null（create なら null、update なら既存値）
  // next: Readonly<Article>（永続化スキーマの型）
};
```

| 型                                 | `open()` で取り出せるプロパティ       |
| ---------------------------------- | ------------------------------------- |
| `Persistable<M, "create", Pre, A>` | `pre: null`, `next`, `actor`          |
| `Persistable<M, "update", Pre, A>` | `pre: Readonly<Pre>`, `next`, `actor` |
| `Deletable<M, Pre, A>`             | `pre: Readonly<Pre>`, `actor`         |
| `Decision<Ac, T, A>`               | `value: T`, `actor`                   |

- `Pre` と `A` の型引数は省略可能で、省略時はそれぞれ `Persisted<M>` と、model / action を作った `domainDefinitionKit` で決めた `actor` の型になります。
- `open()` が返すオブジェクトおよび `pre` / `next` は浅く凍結（`Object.freeze`）されており、型上も `Readonly` です。
- 返り値をスプレッド構文などで複製した偽造オブジェクトを `open()` に渡すと、型エラーかつ実行時エラー（`Panic`）になります。

---

## ルール構成を確認する (`plan`)

`plan()` を使うと、実行せずにルールパイプラインの構成（ルール名・`when` の説明・利用するポート名）を取得できます。

```ts
import { plan } from "domain-rules";

plan(articleRules);
// {
//   load: { ports: ["findArticleById"] },
//   save: [{ name: "記事を変更できるのはメンバーだけ", when: { kind: "always" }, ports: [] }, ...],
//   delete: [...]
// }
```
