# domain-rules

ドメインの rule を小さな単位で定義し、必要なデータだけを取得して検証し、検証済みであることを型で証明する TypeScript ライブラリです。

> **Status**: 設計段階です。この README の API は構想であり、まだ実装していません。

## なぜ作るのか

値を保存する前の処理を手で書くと、次の問題が起きます。

- **rule の当たる条件が `if` の中に埋もれる。** 「新規作成のときだけ」「下書きから公開に変わるときだけ」といった条件が、本体のコードを読まないと分かりません。
- **取得の工程を手で書く必要がある。** どの rule が何を使うかを意識しながら取得処理を書き、順序や重複を自分で管理することになります。
- **既存の値とのマージを毎回書く。** 更新のたびに「入力がなければ既存の値を使う」という処理を、項目ごとに書くことになります。
- **rule が repository に直接依存する。** rule の中で repository を呼ぶと、テストに mock が必要になります。
- **「検証済み」が保証されない。** 検証を通さずに保存する値を組み立てても、型では防げません。

## 中心となる考え方

### 1本の線路

1回の呼び出しは、並べた step を順に通る1本の線路です。step はすべて `Result` を返します。成功すると次の step へ進み、失敗するとその失敗で止まります。ライブラリは step の順序を組み替えません。

線路を流れるのは状態です。保存なら `{ pre, next, actor, now }` から始まります。step は状態を受け取り、成功すると次の状態を返します。step が状態の項目をより強い型の値に置き換えると、後ろの step はその型の状態を受け取ります。これが型の昇格です。

入力の検証、既存の値の取得、マージ、封も step です。これらはライブラリが線路の両端に置きます。その間に、rule の組に並べた rule が並びます。

### rule の組は対象と1対1

rule は、操作ごとではなく対象ごとに1組だけ持ちます。ある記事を保存するときに守るべき rule は、どの画面や API から保存しても同じだからです。「公開する」は、status が DRAFT から PUBLISHED に変わる保存にすぎません。どの rule が当たるかは、各 rule の `when` が値の変化を見て決めます。

| 対象 | rule の組 | 呼び出し方 |
|---|---|---|
| model | model ごとに1つ。保存の rule と削除の rule を持つ | `create`、`update`、`upsert`、`delete` |
| action | action ごとに1つ。rule と、成功時に返す値の組み立てを持つ | `decide` |

新規作成か更新かは、rule の違いではなく呼び出し方の違いです。そのため、同じ保存の rule が `create`、`update`、`upsert` のどれにも当たります。

### 部品と責務

| 部品 | 責務 | 持つもの |
|---|---|---|
| model | 値の形 | 入力の schema と永続化の schema |
| action | 保存を伴わない操作の入力の形 | 入力の schema |
| rule | 線路の1つの step | 名前、`requires`、`when`、`check` |
| port | check から呼ぶ外の機能の宣言 | 名前、引数と結果と失敗の型 |
| cached | port に、1回の呼び出しの中での cache を付ける | 元の port |
| modelRules | model の rule の組 | 既存の値を取る port、保存の rule の並び、削除の rule の並び |
| actionRules | action の rule の組 | rule の並び、`output` |
| provider | port の実装 | check から呼ぶ port、既存の値を取る port、時計の実装 |
| bind | rule の組と provider を束ね、呼び出せるメソッドを作る | なし |

成功と失敗は [@praha/byethrow](https://github.com/praha-inc/byethrow) の `Result` で表します。provider と、束ねたあとのメソッドは `ResultAsync`(byethrow の型で、`Promise<Result>`)を返します。時計の provider だけは、時刻の数を返します。check は `Result` を返します。port を呼ぶ check は async の関数にして、`Promise<Result>` を返します。

### 定義する場所

| 段階 | 場所 | やること |
|---|---|---|
| 組む | ドメインのパッケージ | model、action、port、rule を定義し、対象ごとに rule の組を作って公開する |
| 束ねる | アプリケーションの組み立て部分(DI の設定) | rule の組の一覧に provider を渡す |
| 実行する | usecase | 束ねた結果の、対象ごとのメソッドを呼ぶ |

この分け方なら、ドメインのパッケージは repository や DB を知らずに済みます。副作用を port として宣言し、provider として外から注入するからです。

## 使用例(構想)

ブログ記事を題材にします。記事はブログに属します。

### model を定義する

```ts
import * as v from "valibot";
import { model, type Persisted, type Value } from "domain-rules";

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

export type ArticleValue = Value<typeof article>;   // schema.input の出力の型
export type Article = Persisted<typeof article>;    // schema.persisted の出力の型
export type ExistingArticle = Omit<Article, "id"> & { id: ArticleIdExisted }; // DB から読んだ記事の型
```

- **`schema.input`。** 入力の値の形です。Valibot の `v.object` でなければなりません。更新のときに、入力にある項目だけをその項目の schema で検証するため、ライブラリが項目ごとの schema(`entries`)を読むからです。そのため、object 全体に付けた検証は使われません。項目をまたぐ条件(「著者とレビュアーは別の人」など)は rule に書きます。
- **`schema.persisted`。** 永続化の形です。DB とやり取りするときの型で、DB に保存する値はこの型です。既存の値の型は、この型に代入できる型です。入力より強い型を持てます。この例では、`blogId` と `reviewerId` を、存在を確かめた id の型にしています(`BlogIdExistedSchema` は `v.pipe(BlogIdSchema, v.brand("BlogIdExisted"))`)。`id` は、既存の記事なら `ArticleIdExisted`、新しく作る記事なら `ArticleIdNew` です。保存するには、すべての項目がこの型になっている必要があります。ライブラリは、この schema で入力も既存の値も検証しません。入力を通すと、確かめていない値に brand が付いてしまうからです。ライブラリはこの schema を、永続化の型を決めるためにだけ使います。
- **作成時の既定値。** `schema.input` の `v.optional` の既定値に書きます。新規作成のときだけ使われます。

model は port を持ちません。既存の値を取る port は利用者が宣言し、rule の組の `load` に渡します(「model の rule の組を作る」を参照)。既存の値の型は、その port の返り値の型から決まります。この例の `ExistingArticle` は、id が `ArticleIdExisted` に絞られた型です。ライブラリは、既存の値を取る port の結果を検証しません。

ライブラリは新しい id を作りません。id も、ほかの項目と同じく rule で昇格します(「確かめた値で型を昇格する」を参照)。

### 線路の種類と状態

rule は、どの線路に属するかを値で受け取ります。線路は3種類あり、それぞれ線路を流れる状態の初めの形が違います。

| 線路 | 書き方 | 状態の初めの形 |
|---|---|---|
| model の保存 | `article.save` | `{ pre: ExistingArticle \| null, next: ArticleValue, actor, now }` |
| model の削除 | `article.delete` | `{ pre: ExistingArticle, next: null, actor, now }` |
| action | `previewArticle.decide` | `{ input, actor, now }` |

- `pre` は既存の値です。DB から読んだ値で、型は rule の組の `load` に渡した port の返り値の型です。新規作成のときは `null` です。
- `next` は変更後の値です。既存の値に入力を重ねたものです。型は `ArticleValue` ですが、入力にない項目には、既存の値がそのまま入っています。
- `now` は呼び出された時刻です。`clock` の provider が返し、1回の呼び出しの中では同じ値です。

線路の種類を値で渡すのは、TypeScript が型引数の一部だけを明示して残りを推論することができないからです。rule の型引数に状態の型を明示すると、`requires` から `check` の引数の型を推論できなくなります。値で渡せば、状態の型も `requires` の型も、すべて引数から推論されます。

前の step で昇格した状態を前提にする rule は、線路の種類に前提の型を付けます。

```ts
article.save.with<{ next: { reviewerId: UserIdExisted } }>()
```

この rule を rule の組に並べるとき、前の step までにその型になっていなければ、型エラーになります。

### port を宣言する

port は、check から呼ぶ外の機能の宣言です。引数、結果、失敗の型を持ちます。実装は持ちません。

```ts
import { port, cached } from "domain-rules";

// 既存の記事を取る。rule の組の load に渡す
export const findArticleById = port("findArticleById")
  .of<(id: ArticleId) => ExistingArticle | null, InfraError>();

// 存在すれば、同じ id を存在を確かめた型で返す
export const requireExistingUser = port("requireExistingUser")
  .of<(id: UserId) => UserIdExisted, "USER_NOT_FOUND" | InfraError>();

// 1回の呼び出しの中で同じ blogId なら、2回目からは cache を返す
export const findBlog = cached(
  port("findBlog").of<(id: BlogId) => Blog | null, InfraError>(),
);

export const findArticlesInBlog = cached(
  port("findArticlesInBlog").of<(blogId: BlogId) => readonly ExistingArticle[], InfraError>(),
);

export const newArticleId = port("newArticleId").of<() => ArticleIdNew, InfraError>();
```

port が何を返すかは、port ごとに違います。昇格した値、数、真偽値、データのどれでもかまいません。呼ぶかどうか、どの引数で呼ぶかは、check が決めます。

check の中で呼ぶ port は、`Result` ではなく成功の値を返します。例えば `await findBlog(id)` は `Blog | null` です。port が失敗したら、ライブラリはそこで線路を止め、port の失敗の値を、その rule の失敗の値にします。check の中で `Result` を組み合わせる必要はありません。

port は線路の種類に属しません。引数を受け取るので、保存の rule からも削除の rule からも action の rule からも呼べます。

`cached` を付けた port は、1回の呼び出しの中で、同じ引数で2回目に呼ばれると、port を呼ばずに1回目の結果を返します。引数は JSON にした文字列で比べます。複数の rule が同じデータを使うとき、取得は1回で済みます。cache は呼び出しごとに捨てます。cache するかどうかは、port を宣言するドメインのパッケージで決めます。1回の呼び出しの中で同じ値を見るかどうかは、check の結果の正しさに関わるからです。

### rule を定義する

rule は線路の1つの step です。1つ目の引数に、どの線路の rule かを渡します。`requires` には、check から呼ぶ port を指定し、check の2つ目の引数で受け取ります。

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

// 許可した status の変化だけを通す。ここにない変化はすべて失敗にする
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

ライブラリは、よく使う形の rule を返す関数をいくつか用意します。

```ts
import { immutable } from "domain-rules";

// 作成後に変えられない項目
export const articleImmutableFields = immutable(article.save, ["blogId", "authorId"]);
```

### when を書く

ライブラリは「状態遷移」という概念を持ちません。「下書き」「承認済み」のような判断は、利用者が書きます。この例では、値についての述語として書いています。述語はただの関数で、ライブラリに登録する必要はありません。

```ts
export const isDraft = (a: ArticleValue) => a.status === "DRAFT";
export const isPublished = (a: ArticleValue) => a.status === "PUBLISHED";
export const isApproved = (a: ArticleValue) => a.approvedAt !== null;
```

| 種類 | when | 使える線路 |
|---|---|---|
| 常に | `always` | すべて |
| 新規作成のとき | `onCreate` | 保存 |
| 項目の値が変わったとき | `changed("slug")`。新規作成のときも満たす | 保存 |
| 項目の値が、ある値から変わったとき | `changed("status", { pre: "DRAFT" })`。新規作成のときは満たさない | 保存 |
| 項目の値が、ある値に変わったとき | `changed("status", { next: "PUBLISHED" })`。新規作成でその値から始まるときも満たす | 保存 |
| 項目の値が、ある値からある値に変わったとき | `changed("status", { pre: "DRAFT", next: "PUBLISHED" })` | 保存 |
| 変更後の値が述語を満たすとき | `next(isPublished)` | 保存 |
| 既存の値が述語を満たすとき | `pre(isDraft)`。新規作成のときは満たさない | 保存、削除 |
| 操作した人が述語を満たすとき | `actor(isAdmin)`、`actor((a, s) => a.id === s.next.authorId)` | すべて |
| 組み合わせ | `and(...)`、`or(...)`、`not(...)` | すべて |
| 独自の条件 | `(s) => boolean` の関数をそのまま渡す | すべて |

使えない線路の rule に書くと、型エラーになります。

`when` は、その rule に来た時点の状態で評価します。当たらなければ、rule は状態をそのまま次へ渡します。

`changed` の `pre` と `next` には、その項目の値か、その項目の値を受け取る述語を渡します。どちらも、値が変わったときだけ当たります。1つの項目の変化は `changed` で書き、複数の項目にまたがる条件は `pre(述語)` と `next(述語)` を `and` などで組み合わせて書きます。

actor を when に書くか check に書くかは、次のように分けると読みやすくなります。

- **rule を当てるかどうかが、操作した人で変わる。** when に書きます。例えば「管理者以外が公開後に slug を変えたら失敗」は、管理者のときには rule 自体が当たりません。
- **操作した人が条件を満たすかどうかが、rule の中身そのもの。** check に書きます。例えば「公開できるのは今のレビュアーだけ」は、公開という変化のときに当たり、レビュアーでなければ失敗にします。

when の正体は `(s: 状態) => boolean` という関数で、`changed` や `next` などはこの関数を作る関数です。作る関数が返す when には、`{ kind: "changed", field: "status", pre: "DRAFT", next: "PUBLISHED" }` のような説明が付きます。plan はこの説明を使って、当たる条件を表示します。手書きの関数には、`describe("公開済みの記事", (s) => ...)` で説明を付けられます。

### 確かめた値で型を昇格する

check の成功の値は、状態に重なります。`next` の項目や `actor` を、確かめた値で置き換えられます。状態にない名前の値を足すこともできます。値をどう確かめるかは check が決めます。port が返した値を使うこともあれば、既存の値を使うこともあります。

```ts
export const reviewerExists = rule(article.save, {
  name: "レビュアーが存在する",
  requires: { requireExistingUser },
  when: always,
  check: async ({ pre, next }, { requireExistingUser }) => {
    // 既存の値は確かめて保存したものなので、変わっていなければ取得しない
    if (pre && pre.reviewerId === next.reviewerId) {
      return Result.succeed({ next: { reviewerId: pre.reviewerId } });
    }
    const reviewerId = await requireExistingUser(next.reviewerId);
    return Result.succeed({ next: { reviewerId } });
  },
});

// Blog は blog の model の永続化の型で、id は BlogIdExisted
export const blogExists = rule(article.save, {
  name: "ブログが存在する",
  requires: { findBlog },
  when: always,
  check: async ({ pre, next }, { findBlog }) => {
    if (pre && pre.blogId === next.blogId) {
      return Result.succeed({ next: { blogId: pre.blogId } });
    }
    const blog = await findBlog(next.blogId);
    return blog
      ? Result.succeed({ next: { blogId: blog.id } })
      : Result.fail("BLOG_NOT_FOUND");
  },
});

// findBlog は cached なので、blogExists が同じ blogId で呼んでいれば取得しない
export const blogAcceptsPosts = rule(article.save.with<{ next: { blogId: BlogIdExisted } }>(), {
  name: "投稿を受け付けているブログ",
  requires: { findBlog },
  when: changed("status", { next: "PUBLISHED" }),
  check: async ({ next }, { findBlog }) => {
    const blog = await findBlog(next.blogId);
    return blog?.acceptsPosts ? Result.succeed() : Result.fail("BLOG_CLOSED");
  },
});
```

`reviewerExists` を通ったあとの状態では、`next.reviewerId` は `UserIdExisted` です。`requireExistingUser` は、ユーザーが存在すれば同じ id を `UserIdExisted` として返し、存在しなければ `USER_NOT_FOUND` で失敗します。その失敗は、そのまま `reviewerExists` の失敗になります。同じ id のままの更新では、既存の値を引き継ぎます。既存の値は最初から `UserIdExisted` なので、どちらの経路でもキャストは要りません。

`when` が当たらずに飛ばされる rule は、状態を変えません。そのため、昇格する rule に `always` 以外の `when` を書くと、その rule のあとの型は「昇格した型か、していない型」の和になります。昇格した型を要求する rule が後ろにあるか、永続化の型が揃わなければ、rule の組を作るときに型エラーになります。

記事の id も、同じように rule で昇格します。merge のあとの `next.id` は、入力の型の `ArticleId | undefined` です。

```ts
// 既存の記事なら、その id は存在を確かめたもの
export const existingArticleId = rule(article.save, {
  name: "既存の記事の id",
  when: always,
  check: ({ pre }) => Result.succeed({ next: { id: pre ? pre.id : null } }),
});

export const articleIdAssigned = rule(
  article.save.with<{ next: { id: ArticleIdExisted | null } }>(),
  {
    name: "新しい記事に id を付ける",
    requires: { newArticleId },
    when: always,
    check: async ({ next }, { newArticleId }) =>
      Result.succeed({ next: { id: next.id ?? (await newArticleId()) } }),
  },
);
```

`existingArticleId` は `next.id` を `ArticleIdExisted | null` にし、`articleIdAssigned` は `ArticleIdExisted | ArticleIdNew` にします。`articleIdAssigned` は `when: onCreate` ではなく `always` で、check の中で分けています。`when: onCreate` にすると、その rule のあとの `next.id` の型に `null` が残るからです。この例では、2つの rule を並びの最後に置いています。後ろの rule で失敗したときに、作った id が無駄にならないようにするためです。どこに置くかは、rule の組を作る人が決めます。

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

### model の rule の組を作る

model ごとに、rule の組を1つ作ります。並べた順が、線路の順です。

```ts
import { modelRules } from "domain-rules";

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
```

- **`load`。** 既存の値を取る port です。ライブラリは入力の `id` でこの port を呼び、`null` なら load の step で失敗します。返り値の型は、model の `schema.persisted` の型に代入できなければなりません。`save` で `update` や `upsert` を、または `delete` を使うときに要ります。
- **`save`。** `article.save` の rule を並べます。`create`、`update`、`upsert` のどれで呼ばれても、この並びを順に通ります。
- **`delete`。** `article.delete` の rule を並べます。`delete` を書かなければ、その model は削除できません。束ねたあとに `delete` のメソッドが作られないからです。`save` も同じです。

rule の組を作るとき、並びを先頭から順にたどって、状態の型を確かめます。

- **前提の型。** `blogAcceptsPosts` は `next.blogId` が `BlogIdExisted` であることを前提にしています。`blogExists` より前に並べると型エラーになります。
- **永続化の型。** 並びの最後の状態で、`next` が model の `schema.persisted` の型にならなければ型エラーになります。`reviewerExists` を並べ忘れると、`next.reviewerId` が `UserId` のままなので型エラーになります。`articleIdAssigned` を並べ忘れると、`next.id` に `null` が残るので型エラーになります。

認証済みの actor は利用者が渡します。ライブラリは認証も認可もしません。この例では、認可を rule で書いています。

actor の型そのものは、アプリケーションが1回だけ登録します。

```ts
declare module "domain-rules" {
  interface Register {
    actor: AppActor;
  }
}
```

1つの model に、rule の組は1つだけです。同じ model の rule の組を2つ束ねようとすると、`bind` がエラーにします。

### action の rule の組を作る

何も保存せず、「この操作をしてよいか」と「そのとき何が分かったか」だけを返す操作は、action として定義します。プレビューの閲覧、ファイルのダウンロード、外部の装置への指示などです。action の入力の schema には、Standard Schema を実装したどのライブラリの schema も使えます。

```ts
import { action, actionRules, cached, port, rule, always } from "domain-rules";

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
  check: ({ article }) =>
    article.status !== "ARCHIVED" ? Result.succeed() : Result.fail("ARCHIVED"),
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
```

`output` は線路の最後の step で、最後の状態から返す値を組み立てます。最後の状態に `output` が読む値がそろわなければ、型エラーになります。`output` を省略した action は、成功を `Decision<A, void>` で返します。

### provider を定義して束ねる

provider は port の実装です。check から呼ぶ port、既存の値を取る port、時計のどれでも、同じ `provide` で渡します。この例では、ドメインの外で定義しています。

```ts
import { provide, bind, clock } from "domain-rules";
import { articleRules, findArticle, findArticleById, findArticlesInBlog, findBlog, newArticleId, previewArticleRules, requireExistingUser } from "@example/domain";

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

provider の不足を型で検出するには、provider の一覧を `as const` を付けた読み取り専用のタプルにする必要があります。普通の配列だと、要素を1つ消しても配列の型が変わらないからです。

この例では、`bind` を起動時に1回だけ呼んでいます。`bind` は provider の確認を2段階で行います。

- **型での確認。** rule の組の `load` と、rule が `requires` に書いた port のうち、provider の一覧にないものがあれば型エラーにします。
- **起動時の確認。** provider の不足と、同じ port の重複を確かめ、見つかればエラーにします。

provider の実装が、別の repository や別の取得を使うのは自由です。どう取るかは provider の中の都合なので、ライブラリは provider 同士の依存を扱いません。

テストでは、固定の値を返す provider で束ねるだけで済みます。repository の mock はいりません。

```ts
const testDomain = bind([articleRules], {
  providers: [
    provide.value(findArticleById, existingArticle),
    provide.value(newArticleId, ArticleIdNewSchema.parse("art_1")),
    provide.value(requireExistingUser, UserIdExistedSchema.parse("usr_1")),
    provide.value(findBlog, openBlog),
    provide.value(findArticlesInBlog, []),
    provide.value(clock, 1_700_000_000_000),
  ] as const,
});
```

### 実行する(usecase)

この例の usecase は、束ねた結果の、対象ごとのメソッドを呼ぶだけです。rule も provider も知りません。

```ts
const saved = await Result.pipe(
  domain.article.update({ input: { id: articleId, status: "PUBLISHED" }, actor }),
  Result.andThen((persistable) => repository.save(persistable)), // save は Persistable しか受け取らない
);
```

| メソッド | 受け取るもの | 返すもの |
|---|---|---|
| `create` | `{ input, actor }` | `Persistable<M, "create">` |
| `update` | `{ input, actor }`。`input.id` は必須 | `Persistable<M, "update">` |
| `upsert` | `{ input, actor }` | `Persistable<M, "create"> \| Persistable<M, "update">` |
| `delete` | `{ input: { id }, actor }` | `Deletable<M>` |
| `decide` | `{ input, actor }` | `Decision<A, T>` |

`input` は、`schema.input` の入力の型を `Partial` にしたものです。`create` の `input` は `id` を持ちません。`upsert` は、`input.id` がなければ新規作成、あって既存の値が見つかれば更新、あって見つからなければ load の step で失敗します。利用者が id を決めて新規作成する使い方は、まだ扱いません(未決定の論点を参照)。

### 返り値は封をした値

メソッドが返す `Persistable`、`Deletable`、`Decision` は、中身を直接持たない、封をした値です。中身は `open` で取り出します。

```ts
import { open } from "domain-rules";

const save = (p: Persistable<typeof article, "create" | "update">) => {
  const { pre, next, actor } = open(p);
  // pre: Readonly<ExistingArticle> | null。create なら null、update なら Readonly<ExistingArticle>
  // next: Readonly<Article>。永続化の型
  ...
};
```

| 返り値 | `open` で取り出せるもの |
|---|---|
| `Persistable<M, "create">` | `pre: null`、`next`、`actor` |
| `Persistable<M, "update">` | `pre`(既存の値)、`next`、`actor` |
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
  | { step: "input"; error: { issues: SchemaIssue[] } }       // 入力が schema を満たさない
  | { step: "load"; error: "NOT_FOUND" | LoadError }           // 既存の値がないか、既存の値を取る port が失敗した
  | { step: "著者とレビュアーは別の人"; error: "SAME_AUTHOR_AND_REVIEWER" }
  | { step: "レビュアーが存在する"; error: "USER_NOT_FOUND" | InfraError }
  | ...;                                                        // 並べた rule ごとに1つ
```

rule の失敗の値は、check が `Result.fail` に入れた値そのものです。conflict か、not found か、infra の失敗かは、利用者が失敗の値で表します。ライブラリは失敗に種類を付けません。check の中で呼んだ port が失敗したときは、port の失敗の値が、そのまま rule の失敗の値になります。port の失敗を別の値にしたいときは、port の側で、失敗ではなく値として返します(例えば、見つからないことを `null` で返す)。

## 実行モデル

束ねたメソッドは、呼ばれるたびに次の step を順に通ります。

| 順 | step | やること | 失敗 |
|---|---|---|---|
| 1 | input | 入力を schema で検証する | 検証で見つかった問題 |
| 2 | load | rule の組の `load` の port で、入力の `id` の既存の値を取る | `NOT_FOUND`、load の port の失敗 |
| 3 | merge | 既存の値に、検証済みの入力を重ねて next を作る | なし |
| 4 | rule | rule の組に並べた rule を、並べた順に1つずつ通る | その rule の check の失敗 |
| 5 | seal または output | 保存では最後の状態に封をする。action では `output` で値を組み立てて封をする | なし |

- **input。** 入力は、入力にある項目だけを、その項目の schema で検証します。schema にない項目が入っていたら失敗です。`create` では、入力全体を schema で検証し、既定値を入れます。この step の失敗の値には、schema の検証で見つかった問題がすべて入ります。
- **merge。** 入力で `undefined` の項目は既存の値を残し、`null` の項目は `null` で上書きします。残した項目は、永続化の型のままです。既存の値は信用し、検証しません。
- **rule。** rule ごとに、その時点の状態で `when` を評価します。当たらなければ、状態をそのまま次へ渡します。当たれば check を実行し、成功の値を状態に重ねて次へ渡します。失敗したら、そこで止まります。
- **seal。** 最後の状態の `next` に封をして `Persistable` を作ります。`next` が `schema.persisted` の型になっていることは、rule の組を作るときに型で確かめてあります。

メソッドによって、通らない step があります。

- **`create`。** load を通りません。
- **`delete`。** merge を通りません。
- **`decide`。** load と merge を通りません。input では、入力の全体を action の入力の schema で検証します。

`plan` は、rule の組の線路を、実行せずに表示します。並べた順の rule と、各 rule の `when` の説明と、呼べる port を返します。

```ts
plan(articleRules);
// { save: [{ name: "記事を変更できるのはメンバーだけ", when: { kind: "always" }, ports: [] }, ...], delete: [...] }
```

## データ取得の方針

- **取得の順序。** 取得は、check が port を呼んだときに起きます。ライブラリが先回りして取得することはありません。
- **batch。** 同じ種類で引数だけ違う取得をまとめる機能は、将来の課題です。
- **リクエストをまたぐキャッシュ。** 行いません。rule は最新のデータで check する前提なので、古い値で check が通ると不正なデータが保存されます。

## 設計原則

- **1本の線路。** すべての step は `Result` を返し、最初の失敗で止まります。順序は並べた順で、ライブラリは組み替えません。
- **rule の組は対象と1対1。** 操作ごとに rule の組を作りません。どの rule が当たるかは `when` が値の変化から決めます。一覧に並べた rule は、操作ごとに並べ直す必要がありません。
- **小さな単位で定義する。** model、action、port、rule は1つずつ独立した値です。
- **型の昇格は状態の型の変化。** 確かめた step が、確かめた値で状態を置き換えます。確かめたと宣言するだけで型を強くする手段は持ちません。
- **DB とやり取りする値は永続化の型。** 保存する値も既存の値も、永続化の型です。既存の値は確かめて保存したものなので、マージでもその型のまま引き継ぎます。
- **境界で受け取り、中では信じる。** 入力は最初の step で検証します。既存の値と、provider が返す値は検証しません。
- **副作用は port で注入する。** check は、`requires` に宣言した port を2つ目の引数で受け取ります。既存の値の取得と時計も port です。
- **値の形は schema、項目をまたぐ条件は rule。** schema は項目ごとの形を表し、更新では入力にある項目だけを検証します。項目をまたぐ条件は rule に書くので、更新のたびに値の全体を検証し直す必要はありません。
- **マージの規則は1つにする。** `undefined` は「変えない」、`null` は「空にする」です。
- **線路の種類を値で渡す。** rule は、`article.save` のような値で線路の種類を受け取ります。種類の違うものを組み合わせると型エラーになり、型引数を明示しなくても型が推論されます。
- **ライブラリは状態遷移、認証、認可を持たない。**
- **`when` は同期の関数。** その rule に来た時点の状態で評価します。
- **失敗の値は利用者が決める。** ライブラリは、どの step で失敗したかだけを付けます。
- **返り値は封をした値。** 証明は、メソッドが作った値そのものに結び付きます。別の値や別の操作に付け替えることはできません。

## スコープ外

- **永続化。** `Persistable` や `Deletable` を受け取って保存・削除するのは利用者の責務です。
- **並行実行での整合性(TOCTOU)。** 一意性などは、DB の制約と併用することになります。
- **複数の値をまとめて変更する操作。** 1回の呼び出しで扱うのは1つの値です。同じ操作の中で複数の値の入れ替えを check する、といった使い方は扱いません。
- **API ごとの入力の形。** 「この API からは status しか受け取らない」のような制限は、usecase が受け取る型を狭めて行います。「status を変えられるのはレビュアーだけ」のようなドメインの制限は、rule として書きます。
- **通信の形からの変換。** GraphQL や HTTP の型を、メソッドの引数に詰め替えるのは利用者の責務です。
- **時間経過による自動遷移やワークフローの実行。**

## 先行事例

- **Railway Oriented Programming**(Scott Wlaschin)。`Result` を返す関数を1本の線路につなぎ、最初の失敗で止める考え方です。実行モデルの土台です。
- **Haxl**(Facebook)。データの取得を自動で重複除去する Haskell ライブラリです。論文は "There is no Fork"(ICFP 2014)。`cached` の重複除去がこれにあたります。Haxl が行う並列化と batch は、ここでは行いません。
- **Ports and Adapters と Effect の `Context.Tag`**。必要なものを型付きの宣言として表し、実装は外から注入する考え方です。port と provider の関係がこれにあたります。
- **Event-B と Design by Contract**。不変条件と遷移のガードを分けて書く考え方です。
- **Parse, don't validate**(Alexis King)。検証が通ったら、より強い型に変える考え方です。境界での検証と、check による型の昇格と、封をした返り値がこれにあたります。
- **Standard Schema**。schema ライブラリに共通のインターフェースです。action の入力の schema は、これに対応したものを使えます。

## 未決定の論点

- **線路をたどる型の計算が成り立つか。** 並べたタプルを先頭から順にたどり、状態の型を step ごとに変えながら、各 rule の前提の型と照合し、最後に永続化の型と照合します。この計算が型で成り立つか、rule の数が増えても実用的な速さで終わるかは、まだ試していません。
- **型での provider の確認がどこまで成り立つか。** rule の組の並びと provider のタプルから、必要な port の不足を推論できるかは、まだ試していません。
- **`cached` の引数の比べ方。** 今は JSON にした文字列で比べます。JSON にできない値を引数に取る port をどう扱うかは決めていません。
- **同じ項目を2つの rule が昇格したときの扱い。** 後ろの rule の値で置き換えるのか、型エラーにするのかを決めていません。
- **利用者が決めた id での新規作成。** `upsert` で、指定した id が見つからないときに、その id で作成する使い方は扱っていません。
- **入れ子の値のマージ。** 今の規則は1段目の項目だけを重ねます。
- **actor の型の登録方法。** 今は `Register` への型の登録(module augmentation)で、アプリケーション全体で1つの actor の型を使う想定です。

## License

未定
