# domain-rules

ドメインルールを小さな単位で定義し、1本の線路に並べて検証し、検証済みであることを型で証明する TypeScript ライブラリです。

> **Status**: 設計段階です。この README の API は構想であり、まだ実装していません。

## なぜ作るのか

エンティティを保存する前の処理を手で書くと、次の問題が起きます。

- **ルールの適用条件が `if` の中に埋もれる。** 「新規作成のときだけ」「下書きから公開に変わるときだけ」といった条件が、本体のコードを読まないと分かりません。
- **取得の重複を自分で管理する。** 複数のルールが同じデータを使うとき、取得を1回にまとめる処理を手で書くことになります。
- **既存の値とのマージを毎回書く。** 更新のたびに「入力がなければ既存の値を使う」という処理を、項目ごとに書くことになります。
- **ルールが repository に直接依存する。** ルールの中で repository を呼ぶと、テストに mock が必要になります。
- **「検証済み」が保証されない。** 検証を通さずに保存用のオブジェクトを組み立てても、型では防げません。

## 中心となるモデル

### 1本の線路

1回の呼び出しは、並べた step を順に通る1本の線路です。step はすべて `Result` を返します。成功すると次の step へ進み、失敗するとその失敗で止まります。ライブラリは step の順序を組み替えません。

線路を流れるのは状態です。保存なら `{ pre, next, actor, now }` から始まります。step は状態を受け取り、成功すると次の状態を返します。step が状態の項目をより強い型の値に置き換えると、後ろの step はその型の状態を受け取ります。これが型の昇格です。

入力の検証、既存の値の取得、マージ、保存用の値の封も step です。これらはライブラリが線路の両端に置きます。その間に、ルールの組に並べた rule が並びます。

### ルールの組は対象と1対1

ルールは、操作ごとではなく対象ごとに1組だけ持ちます。ある記事を保存するときに守るべきルールは、どの画面や API から保存しても同じだからです。「公開する」は、status が DRAFT から PUBLISHED に変わる保存にすぎません。どのルールが当たるかは、各ルールの `when` が値の変化を見て決めます。

| 対象 | ルールの組 | 呼び出し方 |
|---|---|---|
| model | model ごとに1つ。保存のルールと削除のルールを持つ | `create`、`update`、`upsert`、`delete` |
| action | action ごとに1つ。判定のルールと、成功時に返す値の組み立てを持つ | `decide` |

新規作成か更新かは、ルールの違いではなく呼び出し方の違いです。そのため、同じ保存のルールが `create`、`update`、`upsert` のどれにも当たります。

### 部品と責務

| 部品 | 責務 | 持つもの |
|---|---|---|
| model | エンティティの形と、取り出し方 | 値の schema、保存済みの値の型、id の schema、取得のキーの schema、model の port(キーから取る、新しい id を作る) |
| action | 保存を伴わない操作の入力の形 | 入力の schema |
| rule | 線路の1つの step | 名前、`requires`、`when`、`check` |
| port | check から呼ぶ外の機能の宣言 | 名前、引数と結果と失敗の型 |
| cached | port に、1回の実行の中での cache を付ける | 元の port |
| entityRules | model のルールの組 | 保存の rule の並び、削除の rule の並び |
| actionRules | action のルールの組 | 判定の rule の並び、`output` |
| provider | port の実装 | port の実装。model の port と時計を含む |
| bind | ルールの組と provider を束ね、呼び出せるメソッドを作る | なし |

成功と失敗は [@praha/byethrow](https://github.com/praha-inc/byethrow) の `Result` で表します。port の実装と、束ねたあとのメソッドは `ResultAsync`(byethrow の型で、`Promise<Result>`)を返します。check は、port を呼ばなければ `Result`、呼ぶなら `ResultAsync` を返します。

### 定義する場所

| 段階 | 場所 | やること |
|---|---|---|
| 組む | ドメインのパッケージ | model、action、port、rule を定義し、対象ごとにルールの組を作って公開する |
| 束ねる | アプリケーションの組み立て部分(DI の設定) | ルールの組の一覧に provider を渡す |
| 実行する | usecase | 束ねた結果の、対象ごとのメソッドを呼ぶ |

ドメインのパッケージは repository や DB を一切知りません。副作用はすべて port として宣言され、provider として外から注入されます。

## 使用例(構想)

ブログ記事を題材にします。記事はブログに属し、ブログの id と記事の id の組で取り出します。

### model を定義する

```ts
import * as v from "valibot";
import { model, stored, type Entity, type Stored, type Value } from "domain-rules";

export const ArticleIdSchema = v.pipe(v.string(), v.startsWith("art_"), v.brand("ArticleId"));

const articleSchema = v.object({
  blogId: BlogIdSchema,
  status: v.optional(v.picklist(["DRAFT", "PUBLISHED", "ARCHIVED"]), "DRAFT"),
  authorId: UserIdSchema,
  reviewerId: UserIdSchema,
  slug: v.pipe(v.string(), v.minLength(1)),
  publishAt: v.pipe(v.number(), v.integer()),
  approvedAt: v.optional(v.nullable(v.number()), null),
});

type ArticleSchemaOutput = v.InferOutput<typeof articleSchema>;

export const article = model({
  name: "article",
  id: ArticleIdSchema,
  key: v.object({ blogId: BlogIdSchema, id: ArticleIdSchema }),
  schema: articleSchema,
  stored: stored<
    Omit<ArticleSchemaOutput, "blogId" | "reviewerId"> & {
      blogId: BlogIdExisted;
      reviewerId: UserIdExisted;
    }
  >(),
});

export type ArticleValue = Value<typeof article>;   // schema の出力の型
export type StoredArticle = Stored<typeof article>; // 保存済みの値の型
export type Article = Entity<typeof article>;       // { id: ArticleId } と StoredArticle を合わせたもの
```

- **`schema`。** 入力の値の形です。Valibot の `v.object` を使います。更新のときに、入力にある項目だけをその項目の schema で検証するため、ライブラリが項目ごとの schema(`entries`)を読む必要があるからです。項目をまたぐ条件(「著者とレビュアーは別の人」など)は、schema ではなく rule に書きます。
- **`stored`。** 保存済みの値の型です。schema の出力の型より強い型を持てます。この例では、`blogId` と `reviewerId` が、存在を確かめた id の型です。保存するには、すべての項目がこの型になっている必要があります。
- **`id`。** 新しく作る id の形です。
- **`key`。** 既存の値を取り出すときに受け取るキーの形です。省略すると `{ id }` になります。
- **作成時の既定値。** schema の `v.optional` の既定値に書きます。新規作成のときだけ使われます。

model は2つの port を自動で宣言します。`article.load` は「キーから既存の記事を取る」、`article.newId` は「新しい id を1つ作る」です。どちらも実装は provider として後から注入します。`article.load` は `Article` を返すので、既存の値は最初から保存済みの値の型です。

### 判定の種類と状態

rule は、どの判定に属するかを値で受け取ります。判定は3種類あり、それぞれ線路を流れる状態の初めの形が違います。

| 判定 | 書き方 | 状態の初めの形 |
|---|---|---|
| model の保存 | `article.save` | `{ pre: Article \| null, next: ArticleValue, actor, now }` |
| model の削除 | `article.delete` | `{ pre: Article, next: null, actor, now }` |
| action の判定 | `previewArticle.decide` | `{ input, actor, now }` |

- `pre` は変更前の値です。新規作成のときは `null` です。
- `next` は変更後の値です。既存の値に入力を重ねたものです。型は `ArticleValue` ですが、入力にない項目には、保存済みの値がそのまま入っています。
- `now` は呼び出された時刻で、1回の実行の中では同じ値です。

判定の種類を値で渡すのは、TypeScript が型引数の一部だけを明示して残りを推論することができないからです。rule の型引数に状態の型を明示すると、`requires` から `check` の引数の型を推論できなくなります。値で渡せば、状態の型も `requires` の型も、すべて引数から推論されます。

前の step で昇格した状態を前提にする rule は、判定の種類に前提の型を付けます。

```ts
article.save.with<{ next: { reviewerId: UserIdExisted } }>()
```

この rule をルールの組に並べるとき、前の step までにその型になっていなければ、型エラーになります。

ライブラリは「状態遷移」という概念を持ちません。「下書き」「承認済み」のような判断は、値についての述語としてドメインの側に書きます。述語はただの関数で、ライブラリに登録する必要はありません。

```ts
export const isDraft = (a: ArticleValue) => a.status === "DRAFT";
export const isPublished = (a: ArticleValue) => a.status === "PUBLISHED";
export const isApproved = (a: ArticleValue) => a.approvedAt !== null;
```

### port を宣言する

port は、check から呼ぶ外の機能の宣言です。引数、結果、失敗の型を持ちます。実装は持ちません。

```ts
import { port, cached } from "domain-rules";

// 存在すれば、同じ id を存在を確かめた型で返す
export const requireExistingUser = port("requireExistingUser")
  .of<(id: UserId) => UserIdExisted, "USER_NOT_FOUND" | InfraError>();

// 1回の実行の中で同じ blogId なら、2回目からは cache を返す
export const findBlog = cached(
  port("findBlog").of<(id: BlogId) => Blog | null, InfraError>(),
);

export const findArticlesInBlog = cached(
  port("findArticlesInBlog").of<(blogId: BlogId) => readonly Article[], InfraError>(),
);
```

port が何を返すかは、port ごとに違います。昇格した値、数、真偽値、データのどれでもかまいません。呼ぶかどうか、どの引数で呼ぶかは、check が決めます。

`cached` を付けた port は、1回の実行の中で、同じ引数で2回目に呼ばれると、port を呼ばずに1回目の結果を返します。引数は JSON にした文字列で比べます。複数の rule が同じデータを使うとき、取得は1回で済みます。cache は実行ごとに捨てます。cache するかどうかは、port を宣言するドメインの側で決めます。1回の実行の中で同じ値を見るかどうかは、判定の正しさに関わるからです。

### rule を定義する

rule は線路の1つの step です。1つ目の引数に、どの判定の rule かを渡します。`requires` には、check から呼ぶ port を指定し、check の2つ目の引数で受け取ります。

check は、成功すると何も返さないか、状態に重ねる値を返します。失敗の値は自由です。

```ts
import { rule, always, onCreate, changed, next, pre, actor, and, not } from "domain-rules";
import { Result } from "@praha/byethrow";

export const authorIsNotReviewer = rule(article.save, {
  name: "著者とレビュアーは別の人",
  when: always,
  check: (s) =>
    s.next.authorId !== s.next.reviewerId
      ? Result.succeed()
      : Result.fail("SAME_AUTHOR_AND_REVIEWER"),
});

export const uniqueSlugInBlog = rule(article.save, {
  name: "slug はブログ内で一意",
  requires: { findArticlesInBlog },
  when: changed("slug"),
  check: (s, { findArticlesInBlog }) =>
    Result.pipe(
      findArticlesInBlog(s.next.blogId),
      Result.andThen((articles) =>
        articles.some((a) => a.slug === s.next.slug && a.id !== s.pre?.id)
          ? Result.fail("DUPLICATED_SLUG")
          : Result.succeed(),
      ),
    ),
});

export const publishAtInFuture = rule(article.save, {
  name: "公開日時は未来",
  when: changed("publishAt"),
  check: (s) =>
    s.next.publishAt > s.now ? Result.succeed() : Result.fail("PUBLISH_AT_IN_PAST"),
});

// 公開の権限は、変更前のレビュアーで判断する。変更後の値で判断すると、
// 同じ更新でレビュアーを自分に変えれば誰でも公開できてしまう
export const onlyReviewerPublishes = rule(article.save, {
  name: "公開できるのは今のレビュアーだけ",
  when: changed("status", { pre: "DRAFT", next: "PUBLISHED" }),
  check: (s) =>
    s.actor.id === s.pre?.reviewerId ? Result.succeed() : Result.fail("NOT_REVIEWER"),
});

export const onlyAuthorChangesReviewer = rule(article.save, {
  name: "作成後にレビュアーを変えられるのは著者だけ",
  when: and(not(onCreate), changed("reviewerId")),
  check: (s) =>
    s.actor.id === s.pre?.authorId ? Result.succeed() : Result.fail("NOT_AUTHOR"),
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

// 許可した status の変化だけを通す。ここにない変化はすべて違反にする
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
    return allowed.includes(s.next.status)
      ? Result.succeed()
      : Result.fail("STATUS_CHANGE_NOT_ALLOWED");
  },
});

export const onlyDraftIsDeletable = rule(article.delete, {
  name: "削除できるのは下書きだけ",
  when: not(pre(isDraft)),
  check: () => Result.fail("NOT_DRAFT"),
});
```

よく使う形の rule は、rule を返す関数として用意します。

```ts
import { immutable } from "domain-rules";

// 作成後に変えられない項目
export const articleImmutableFields = immutable(article.save, ["blogId", "authorId"]);
```

### when を書く

| 種類 | when | 使える判定 |
|---|---|---|
| 常に | `always` | すべて |
| 新規作成のとき | `onCreate` | 保存 |
| 項目の値が変わったとき | `changed("slug")`。新規作成のときも満たす | 保存 |
| 項目の値が、ある値から変わったとき | `changed("status", { pre: "DRAFT" })`。新規作成のときは満たさない | 保存 |
| 項目の値が、ある値に変わったとき | `changed("status", { next: "PUBLISHED" })`。新規作成でその値から始まるときも満たす | 保存 |
| 項目の値が、ある値からある値に変わったとき | `changed("status", { pre: "DRAFT", next: "PUBLISHED" })` | 保存 |
| 変更後の値が述語を満たすとき | `next(isPublished)` | 保存 |
| 変更前の値が述語を満たすとき | `pre(isDraft)`。新規作成のときは満たさない | 保存、削除 |
| 操作した人が述語を満たすとき | `actor(isAdmin)`、`actor((a, s) => a.id === s.next.authorId)` | すべて |
| 組み合わせ | `and(...)`、`or(...)`、`not(...)` | すべて |
| 独自の条件 | `(s) => boolean` の関数をそのまま渡す | すべて |

使えない判定の rule に書くと、型エラーになります。

`when` は、その rule に来た時点の状態で評価します。当たらなければ、rule は状態をそのまま次へ渡します。

`changed` の `pre` と `next` には、その項目の値か、その項目の値を受け取る述語を渡します。どちらも、値が変わったときだけ当たります。1つの項目の変化は `changed` で書き、複数の項目にまたがる条件は `pre(述語)` と `next(述語)` を `and` などで組み合わせて書きます。

actor を when に書くか check に書くかは、次のように分けます。

- **rule を当てるかどうかが、操作した人で変わる。** when に書きます。例えば「管理者以外が公開後に slug を変えたら違反」は、管理者のときには rule 自体が当たりません。
- **操作した人が条件を満たすかどうかが、rule の中身そのもの。** check に書きます。例えば「公開できるのは今のレビュアーだけ」は、公開という変化のときに当たり、レビュアーでなければ違反にします。

when の正体は `(s: 状態) => boolean` という関数で、`changed` や `next` などはこの関数を作る関数です。作る関数が返す when には、`{ kind: "changed", field: "status", pre: "DRAFT", next: "PUBLISHED" }` のような説明が付きます。plan はこの説明を使って適用条件を表示します。手書きの関数には、`describe("公開済みの記事", (s) => ...)` で説明を付けられます。

### 確かめた値で型を昇格する

check の成功の値は、状態に重なります。`next` の項目や `actor` を、確かめた値で置き換えられます。状態にない名前の値を足すこともできます。値をどう確かめるかは check が決めます。port が返した値を使うこともあれば、保存済みの値を使うこともあります。

```ts
export const reviewerExists = rule(article.save, {
  name: "レビュアーが存在する",
  requires: { requireExistingUser },
  when: always,
  check: async ({ pre, next }, { requireExistingUser }) => {
    // 保存済みの値は確かめ済みなので、変わっていなければ照会しない
    if (pre && pre.reviewerId === next.reviewerId) {
      return Result.succeed({ next: { reviewerId: pre.reviewerId } });
    }
    return Result.pipe(
      requireExistingUser(next.reviewerId),
      Result.map((reviewerId) => ({ next: { reviewerId } })),
    );
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
    return Result.pipe(
      findBlog(next.blogId),
      Result.andThen((blog) =>
        blog ? Result.succeed({ next: { blogId: blog.id } }) : Result.fail("BLOG_NOT_FOUND"),
      ),
    );
  },
});

// findBlog は cached なので、blogExists が同じ blogId で呼んでいれば照会しない
export const blogAcceptsPosts = rule(article.save.with<{ next: { blogId: BlogIdExisted } }>(), {
  name: "投稿を受け付けているブログ",
  requires: { findBlog },
  when: changed("status", { next: "PUBLISHED" }),
  check: ({ next }, { findBlog }) =>
    Result.pipe(
      findBlog(next.blogId),
      Result.andThen((blog) =>
        blog?.acceptsPosts ? Result.succeed() : Result.fail("BLOG_CLOSED"),
      ),
    ),
});
```

`reviewerExists` を通ったあとの状態では、`next.reviewerId` は `UserIdExisted` です。`requireExistingUser` は、ユーザーが存在すれば同じ id を `UserIdExisted` として返します。同じ id のままの更新では、保存済みの値を引き継ぎます。保存済みの値は最初から `UserIdExisted` なので、どちらの経路でもキャストは要りません。

`when` が当たらずに飛ばされる rule は、状態を変えません。そのため、昇格する rule に `always` 以外の `when` を書くと、後ろの step からは「昇格した型か、していない型」に見えます。昇格した型を要求する rule が後ろにあるか、保存済みの値の型が揃わなければ、ルールの組を作るときに型エラーになります。

actor も同じように昇格できます。

```ts
export const isMember = (actor: AppActor): actor is MemberActor =>
  actor.role === "MEMBER" || actor.role === "ADMIN";

const memberOnly = {
  name: "記事を変更できるのはメンバーだけ",
  when: always,
  check: ({ actor }: { actor: AppActor }) =>
    isMember(actor) ? Result.succeed({ actor }) : Result.fail("NOT_MEMBER"),
};

export const memberCanSave = rule(article.save, memberOnly);
export const memberCanDelete = rule(article.delete, memberOnly);
```

`memberCanSave` を通ったあとの状態では、`actor` は `MemberActor` です。

### model のルールの組を作る

model ごとに、ルールの組を1つ作ります。並べた順が、線路の順です。

```ts
import { entityRules } from "domain-rules";

export const articleRules = entityRules(article, {
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
  ],
  delete: [memberCanDelete, onlyDraftIsDeletable],
});
```

- **`save`。** `article.save` の rule を並べます。`create`、`update`、`upsert` のどれで呼ばれても、この並びを順に通ります。
- **`delete`。** `article.delete` の rule を並べます。`delete` を書かなければ、その model は削除できません。束ねたあとに `delete` のメソッドが作られないからです。`save` も同じです。

ルールの組を作るとき、並びを先頭から順にたどって、状態の型を確かめます。

- **前提の型。** `blogAcceptsPosts` は `next.blogId` が `BlogIdExisted` であることを前提にしています。`blogExists` より前に並べると型エラーになります。
- **保存済みの値の型。** 並びの最後の状態で、`next` が model の `stored` の型にならなければ型エラーになります。`reviewerExists` を並べ忘れると、`next.reviewerId` が `UserId` のままなので型エラーになります。

認証済みの actor は呼び出し側が渡します。操作を許可しない場合、認可の rule が失敗を返します。

actor の型そのものは、アプリケーションが1回だけ登録します。

```ts
declare module "domain-rules" {
  interface Register {
    actor: AppActor;
  }
}
```

1つの model に、ルールの組は1つだけです。同じ model のルールの組を2つ束ねようとすると、`bind` がエラーにします。

### action のルールの組を作る

何も保存せず、「この操作をしてよいか」と「そのとき何が分かったか」だけを返す操作は、action として定義します。プレビューの閲覧、ファイルのダウンロード、外部の装置への指示などです。action の入力の schema には、Standard Schema を実装したどのライブラリの schema も使えます。

```ts
import { action, actionRules, cached, port, rule, always } from "domain-rules";

export const previewArticle = action({
  name: "previewArticle",
  input: v.object({ blogId: BlogIdSchema, articleId: ArticleIdSchema }),
});

export const findArticle = cached(
  port("findArticle").of<(blogId: BlogId, id: ArticleId) => Article | null, InfraError>(),
);

export const targetArticleExists = rule(previewArticle.decide, {
  name: "対象の記事が存在する",
  requires: { findArticle },
  when: always,
  check: ({ input }, { findArticle }) =>
    Result.pipe(
      findArticle(input.blogId, input.articleId),
      Result.andThen((article) =>
        article ? Result.succeed({ article }) : Result.fail("ARTICLE_NOT_FOUND"),
      ),
    ),
});

export const notArchived = rule(previewArticle.decide.with<{ article: Article }>(), {
  name: "アーカイブ済みの記事はプレビューできない",
  when: always,
  check: ({ article }) =>
    article.status !== "ARCHIVED" ? Result.succeed() : Result.fail("ARCHIVED"),
});

export const canPreview = rule(previewArticle.decide.with<{ article: Article }>(), {
  name: "プレビューできるのはメンバーの著者かレビュアーだけ",
  when: always,
  check: ({ actor, article }) =>
    !isMember(actor)
      ? Result.fail("NOT_ALLOWED")
      : actor.id === article.authorId
        ? Result.succeed({ viewerRole: "author" as const })
        : actor.id === article.reviewerId
          ? Result.succeed({ viewerRole: "reviewer" as const })
          : Result.fail("NOT_ALLOWED"),
});

export const previewArticleRules = actionRules(previewArticle, {
  rules: [targetArticleExists, notArchived, canPreview],
  output: ({ article, viewerRole }) => ({ article, viewerRole }),
});
```

`output` は線路の最後の step で、最後の状態から返す値を組み立てます。最後の状態に `output` が読む値がそろわなければ、型エラーになります。`output` を省略した action は、判定の成功を `Decision<A, void>` で返します。

### provider を定義して束ねる

provider は port の実装です。check から呼ぶ port、model の port(`load` と `newId`)、時計のどれでも、同じ `provide` で渡します。ドメインの外で定義します。

```ts
import { provide, bind, clock } from "domain-rules";
import { article, articleRules, findArticle, findArticlesInBlog, findBlog, previewArticleRules, requireExistingUser } from "@example/domain";

export const providers = [
  provide(article.load, (key) => articleRepository.find(key.blogId, key.id)),
  provide(article.newId, () => createArticleId()),
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

provider の一覧は、`as const` を付けた読み取り専用のタプルにします。普通の配列だと、要素を1つ消しても配列の型が変わらず、provider の不足を型で検出できないからです。

`bind` は起動時に1回だけ呼びます。provider の確認は2段階で行います。

- **型での確認。** ルールの組の rule が `requires` に書いた port と model の port のうち、provider の一覧にないものがあれば型エラーにします。
- **起動時の確認。** provider の不足と、同じ port の重複を確かめ、見つかればエラーにします。

テストでは、固定の値を返す provider で束ねるだけで済みます。repository の mock はいりません。

```ts
const testDomain = bind([articleRules], {
  providers: [
    provide.value(article.load, existingArticle),
    provide.value(article.newId, "art_1" as ArticleId),
    provide.value(requireExistingUser, "usr_1" as UserIdExisted),
    provide.value(findBlog, openBlog),
    provide.value(findArticlesInBlog, []),
    provide.value(clock, 1_700_000_000_000),
  ] as const,
});
```

### 実行する(usecase)

usecase は、束ねた結果の、対象ごとのメソッドを呼ぶだけです。rule も provider も知りません。

```ts
const saved = await Result.pipe(
  domain.article.update({ key: { blogId, id: articleId }, input: { status: "PUBLISHED" }, actor }),
  Result.andThen((persistable) => repository.save(persistable)), // save は Persistable しか受け取らない
);
```

| メソッド | 受け取るもの | 返すもの |
|---|---|---|
| `create` | `{ input, actor }` | `Persistable<M, "create">` |
| `update` | `{ key, input, actor }` | `Persistable<M, "update">` |
| `upsert` | `{ key?, input, actor }` | `Persistable<M, "create"> \| Persistable<M, "update">` |
| `delete` | `{ key, actor }` | `Deletable<M>` |
| `decide` | `{ input, actor }` | `Decision<A, T>` |

`input` は、schema の入力の型を `Partial` にしたものです。`upsert` は、`key` がなければ新規作成、`key` があって既存の値が見つかれば更新、`key` があって見つからなければ load の step で失敗します。呼び出す側が id を決めて新規作成する使い方は、まだ扱いません(未決定の論点を参照)。

### 返り値は封をした値

メソッドが返す `Persistable`、`Deletable`、`Decision` は、中身を直接持たない、封をした値です。中身は `open` で取り出します。

```ts
import { open } from "domain-rules";

const save = (p: Persistable<typeof article, "create" | "update">) => {
  const { pre, next, actor } = open(p);
  // pre: Readonly<Article> | null。create なら null、update なら Readonly<Article>
  // next: Readonly<Article>。保存済みの値の型
  ...
};
```

| 返り値 | `open` で取り出せるもの |
|---|---|
| `Persistable<M, "create">` | `pre: null`、`next`、`actor` |
| `Persistable<M, "update">` | `pre`(変更前の値)、`next`、`actor` |
| `Deletable<M>` | `pre`(削除する対象)、`actor` |
| `Decision<A, T>` | `value`(`output` が返した値。省略時は `undefined`)、`actor` |

封をした値にするのは、証明を別の値や別の操作に付け替えられないようにするためです。

- **型。** 返り値の型は、操作の種類と対象を型引数に持ちます。`Persistable` を `Deletable` として渡すと型エラーになります。
- **中身の書き換え。** `open` が返す値は読み取り専用で、実行時にも凍結されています。
- **作り直し。** 封をした値をスプレッドなどで作り直したものは、`open` が受け付けずにエラーになります。中身は、メソッドが作った値そのものに結び付けて、ライブラリの中だけで持っているからです。

`actor` は、線路の最後の状態の actor です。rule で昇格していれば、昇格した型です。

### 失敗の型

失敗は1つだけです。どの step で失敗したかと、その step の失敗の値を持ちます。

```ts
type Failure =
  | { step: "input"; error: { issues: SchemaIssue[] } }       // キーか入力が schema を満たさない
  | { step: "load"; error: "NOT_FOUND" | LoadError }           // 既存の値がないか、load の port が失敗した
  | { step: "著者とレビュアーは別の人"; error: "SAME_AUTHOR_AND_REVIEWER" }
  | { step: "レビュアーが存在する"; error: "USER_NOT_FOUND" | InfraError }
  | ...                                                         // 並べた rule ごとに1つ
  | { step: "seal"; error: NewIdError };                        // newId の port が失敗した
```

rule の失敗の値は、check が `Result.fail` に入れた値そのものです。conflict か、not found か、infra の失敗かは、利用者が失敗の値で表します。ライブラリは失敗に種類を付けません。check が呼んだ port の失敗をそのまま返すか、別の値に変えるかも、check が決めます。

## 実行モデル

束ねたメソッドは、呼ばれるたびに次の step を順に通ります。

| 順 | step | やること | 失敗 |
|---|---|---|---|
| 1 | input | キーと入力を schema で検証する | 検証で見つかった問題 |
| 2 | load | キーから既存の値を取る | `NOT_FOUND`、load の port の失敗 |
| 3 | merge | 既存の値に、検証済みの入力を重ねて next を作る | なし |
| 4 | rule | ルールの組に並べた rule を、並べた順に1つずつ通る | その rule の check の失敗 |
| 5 | seal または output | 保存では id を付けて封をする。action では `output` で値を組み立てて封をする | newId の port の失敗 |

- **input。** 入力は、入力にある項目だけを、その項目の schema で検証します。schema にない項目が入っていたら失敗です。`create` では、入力全体を schema で検証し、既定値を入れます。この step の失敗の値には、schema の検証で見つかった問題がすべて入ります。
- **merge。** 入力で `undefined` の項目は既存の値を残し、`null` の項目は `null` で上書きします。残した項目は、保存済みの値の型のままです。既存の値は、provider が正しい形で返す前提で、もう一度は検証しません。
- **rule。** rule ごとに、その時点の状態で `when` を評価します。当たらなければ、状態をそのまま次へ渡します。当たれば check を実行し、成功の値を状態に重ねて次へ渡します。失敗したら、そこで止まります。
- **seal。** 更新なら既存の id、新規なら `model.newId` の provider で作った id を付けます。`newId` が失敗するか、id の schema を満たさない値を返したら失敗です。

メソッドによって、通らない step があります。

- **`create`。** load を通りません。
- **`delete`。** merge を通りません。
- **`decide`。** load と merge を通りません。input では、入力の全体を action の入力の schema で検証します。

`plan` は、ルールの組の線路を、実行せずに表示します。並べた順の rule と、各 rule の `when` の説明と、呼べる port を返します。

```ts
plan(articleRules);
// { save: [{ name: "記事を変更できるのはメンバーだけ", when: { kind: "always" }, ports: [] }, ...], delete: [...] }
```

## データ取得の方針

- **重複除去。** `cached` を付けた port は、1回の実行の中で、同じ引数の2回目から cache を返します。
- **取得の順序。** 取得は、check が port を呼んだときに起きます。ライブラリが先回りして取得することはありません。
- **batch。** 同じ種類で引数だけ違う取得をまとめる機能は、将来の課題です。
- **リクエストをまたぐキャッシュ。** 行いません。rule は最新のデータで判定する前提なので、古い値で判定が通ると不正なデータが保存されます。

## 設計原則

- **1本の線路。** すべての step は `Result` を返し、最初の失敗で止まります。順序は並べた順で、ライブラリは組み替えません。
- **ルールの組は対象と1対1。** 操作ごとにルールの組を作りません。どのルールが当たるかは `when` が値の変化から決めます。一覧に並べた rule は、操作ごとに並べ直す必要がありません。
- **小さな単位で定義する。** model、action、port、rule は1つずつ独立した値です。
- **型の昇格は状態の型の変化。** 確かめた step が、確かめた値で状態を置き換えます。確かめたと宣言するだけで型を強くする手段は持ちません。
- **保存済みの値は確かめ済み。** 既存の値は保存済みの値の型で読み込み、マージでもその型のまま引き継ぎます。
- **境界で受け取り、中では信じる。** キーと入力は最初の step で検証します。actor は呼び出し側で認証し、操作の認可は rule で判定します。
- **副作用はすべて port。** check から呼ぶ port、既存の値の取得、id の生成、時計の実装は、`provide` で注入します。
- **値の形は schema、項目をまたぐ条件は rule。** schema は項目ごとの形を表し、更新では入力にある項目だけを検証します。項目をまたぐ条件は rule に書くので、更新のたびに値の全体を検証し直す必要はありません。
- **マージの規則は1つにする。** `undefined` は「変えない」、`null` は「空にする」です。
- **判定の種類を値で渡す。** rule は、`article.save` のような値で判定の種類を受け取ります。種類の違うものを組み合わせると型エラーになり、型引数を明示しなくても型が推論されます。
- **ライブラリは状態遷移を知らない。** rule が見るのは pre と next の値の変化だけです。
- **`when` は同期の純関数にする。** check は、`requires` に宣言した port だけを呼べます。
- **失敗の値は利用者が決める。** ライブラリは、どの step で失敗したかだけを付けます。
- **返り値は封をした値。** 証明は、メソッドが作った値そのものに結び付きます。別の値や別の操作に付け替えることはできません。

## スコープ外

- **永続化。** `Persistable` や `Deletable` を受け取って保存・削除するのは利用する側の責務です。
- **並行実行での整合性(TOCTOU)。** 一意性などは DB の制約と併用してください。
- **複数の値をまとめて変更する操作。** 1回の呼び出しで扱うのは1つの値です。同じ操作の中で複数の値の入れ替えを判定する、といった使い方は扱いません。
- **API ごとの入力の形。** 「この API からは status しか受け取らない」のような制限は、usecase が受け取る型を狭めて行います。「status を変えられるのはレビュアーだけ」のようなドメインの制限は、rule として書きます。
- **通信の形からの変換。** GraphQL や HTTP の型を、メソッドの引数に詰め替えるのは利用する側の責務です。
- **時間経過による自動遷移やワークフローの実行。**

## 先行事例

- **Railway Oriented Programming**(Scott Wlaschin)。`Result` を返す関数を1本の線路につなぎ、最初の失敗で止める考え方です。実行モデルの土台です。
- **Haxl**(Facebook)。ルールが使うデータの取得を、自動で重複除去する Haskell ライブラリです。論文は "There is no Fork"(ICFP 2014)。`cached` の重複除去がこれにあたります。Haxl が行う並列化と batch は、ここでは行いません。
- **Ports and Adapters と Effect の `Context.Tag`**。必要なものを型付きの宣言として表し、実装は外から注入する考え方です。port と provider の関係がこれにあたります。
- **Event-B と Design by Contract**。不変条件と遷移のガードを分けて書く考え方です。
- **Parse, don't validate**(Alexis King)。検証が通ったら、より強い型に変える考え方です。境界での検証と、check による型の昇格と、封をした返り値がこれにあたります。
- **Standard Schema**。schema ライブラリに共通のインターフェースです。action の入力の schema は、これに対応したものを使えます。

## 未決定の論点

- **線路をたどる型の計算が成り立つか。** 並べたタプルを先頭から順にたどり、状態の型を step ごとに変えながら、各 rule の前提の型と照合し、最後に保存済みの値の型と照合します。この計算が型で成り立つか、rule の数が増えても実用的な速さで終わるかは、まだ試していません。
- **型での provider の確認がどこまで成り立つか。** ルールの組の並びと provider のタプルから、必要な port の不足を推論できるかは、まだ試していません。
- **`cached` の引数の比べ方。** 今は JSON にした文字列で比べます。JSON にできない値を引数に取る port をどう扱うかは決めていません。
- **同じ項目を2つの rule が昇格したときの扱い。** 後ろの rule の値で置き換えるのか、型エラーにするのかを決めていません。
- **呼び出す側が決めた id での新規作成。** `upsert` で、指定したキーが見つからないときに、そのキーで作成する使い方は扱っていません。
- **入れ子の値のマージ。** 今の規則は1段目の項目だけを重ねます。
- **actor の型の登録方法。** 今は `Register` への型の登録(module augmentation)で、アプリケーション全体で1つの actor の型を使う想定です。

## License

未定
