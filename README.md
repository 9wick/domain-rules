# domain-rules

ドメインルールを小さな単位で定義し、必要なデータだけを取得して検証し、検証済みであることを型で証明する TypeScript ライブラリです。

> **Status**: 設計段階です。この README の API は構想であり、まだ実装していません。

## なぜ作るのか

エンティティを保存する前の処理を手で書くと、次の問題が起きます。

- **ルールの適用条件が `if` の中に埋もれる。** 「新規作成のときだけ」「下書きから公開に変わるときだけ」といった条件が、本体のコードを読まないと分かりません。
- **取得の工程を手で書く必要がある。** どのルールが何を使うかを意識しながら取得処理を書き、順序や重複を自分で管理することになります。
- **既存の値とのマージを毎回書く。** 更新のたびに「入力がなければ既存の値を使う」という処理を、項目ごとに書くことになります。
- **ルールが副作用を持つ。** ルールの中で repository を呼ぶと、テストに mock が必要になります。
- **「検証済み」が保証されない。** 検証を通さずに保存用のオブジェクトを組み立てても、型では防げません。

## 中心となるモデル

### ルールの組は対象と1対1

ルールは、操作ごとではなく対象ごとに1組だけ持ちます。ある記事を保存するときに守るべきルールは、どの画面や API から保存しても同じだからです。「公開する」は、status が DRAFT から PUBLISHED に変わる保存にすぎません。どのルールが当たるかは、各ルールの `when` が値の変化を見て決めます。

| 対象 | ルールの組 | 呼び出し方 |
|---|---|---|
| model | model ごとに1つ。保存のルールと削除のルールを持つ | `create`、`update`、`upsert`、`delete` |
| action | action ごとに1つ。判定のルールと、必要に応じて成功時に返す値の指定を持つ | `decide` |

新規作成か更新かは、ルールの違いではなく呼び出し方の違いです。そのため、同じ保存のルールが `create`、`update`、`upsert` のどれにも当たります。

### 部品と責務

| 部品 | 責務 | 持つもの |
|---|---|---|
| model | エンティティの形と、取り出し方 | 値の schema、id の schema、取得のキーの schema、port の宣言(キーから取る、新しい id を作る) |
| action | 保存を伴わない操作の入力の形 | 入力の schema |
| rule | 1つの条件 | `requires`、`when`、`check` |
| preload | port を先に呼んで結果を共有する指定 | 名前、どの判定の Snapshot から決まるか、結果の型 |
| entityRules | model のルールの組 | 保存のルール、削除のルール |
| actionRules | action のルールの組 | 判定のルール、任意の `output` |
| provider | 宣言された port の実装 | port の実装。preload が使う取得や、model の取得・採番、時計を含む |
| bind | ルールの組と provider を束ね、呼び出せるメソッドを作る | なし |

成功と失敗は [@praha/byethrow](https://github.com/praha-inc/byethrow) の `Result` で表します。rule の `check` は `Result`、provider と、束ねたあとのメソッドは `ResultAsync`(`Promise<Result>`)を返します。

### 定義する場所

| 段階 | 場所 | やること |
|---|---|---|
| 組む | ドメインのパッケージ | model、action、preload、rule を定義し、対象ごとにルールの組を作って公開する |
| 束ねる | アプリケーションの組み立て部分(DI の設定) | ルールの組の一覧に provider を渡す |
| 実行する | usecase | 束ねた結果の、対象ごとのメソッドを呼ぶ |

ドメインのパッケージは repository や DB を一切知りません。副作用はすべて port として宣言され、provider として外から注入されます。

## 使用例(構想)

ブログ記事を題材にします。記事はブログに属し、ブログの id と記事の id の組で取り出します。

### model を定義する

```ts
import * as v from "valibot";
import { model, type Entity, type Value } from "domain-rules";

export const ArticleIdSchema = v.pipe(v.string(), v.startsWith("art_"), v.brand("ArticleId"));

export const article = model({
  name: "article",
  id: ArticleIdSchema,
  key: v.object({ blogId: BlogIdSchema, id: ArticleIdSchema }),
  schema: v.object({
    blogId: BlogIdSchema,
    status: v.optional(v.picklist(["DRAFT", "PUBLISHED", "ARCHIVED"]), "DRAFT"),
    authorId: UserIdSchema,
    reviewerId: UserIdSchema,
    slug: v.pipe(v.string(), v.minLength(1)),
    publishAt: v.pipe(v.number(), v.integer()),
    approvedAt: v.optional(v.nullable(v.number()), null),
  }),
});

export type ArticleValue = Value<typeof article>;   // schema の出力の型。id を持たない
export type Article = Entity<typeof article>;       // { id: ArticleId } と ArticleValue を合わせたもの
```

- **`schema`。** 値の形です。Valibot の `v.object` を使います。更新のときに、入力にある項目だけをその項目の schema で検証するため、ライブラリが項目ごとの schema(`entries`)を読む必要があるからです。項目をまたぐ条件(「著者とレビュアーは別の人」など)は、schema ではなく rule に書きます。
- **`id`。** 新しく作る id の形です。
- **`key`。** 既存の値を取り出すときに受け取るキーの形です。省略すると `{ id }` になります。
- **作成時の既定値。** schema の `v.optional` の既定値に書きます。新規作成のときだけ使われます。

model は2つの port を自動で宣言します。`article.load` は「キーから既存の記事を取る」、`article.newId` は「新しい id を1つ作る」です。どちらも実装は provider として後から注入します。

### 判定の種類と Snapshot

rule と preload は、どの判定に属するかを値で受け取ります。判定は3種類あり、それぞれ受け取る Snapshot の形が違います。

| 判定 | 書き方 | Snapshot |
|---|---|---|
| model の保存 | `article.save` | `{ pre: Entity \| null, next: Value, actor, now }` |
| model の削除 | `article.delete` | `{ pre: Entity, next: null, actor, now }` |
| action の判定 | `previewArticle.decide` | `{ input, actor, now }` |

- `pre` は変更前の値です。新規作成のときは `null` です。
- `next` は変更後の値です。既存の値に入力を重ねたものです。
- `now` は呼び出された時刻で、1回の実行の中では同じ値です。

判定の種類を値で渡すのは、TypeScript が型引数の一部だけを明示して残りを推論することができないからです。rule の型引数に Snapshot の型を明示すると、`requires` から `check` の引数の型を推論できなくなります。値で渡せば、Snapshot の型も `requires` の型も、すべて引数から推論されます。

Snapshot の actor は、アプリケーションが登録した型です。操作を許可する条件は rule の `check` に書きます。

ライブラリは「状態」という概念を持ちません。「下書き」「承認済み」のような判断は、値についての述語としてドメインの側に書きます。述語はただの関数で、ライブラリに登録する必要はありません。

```ts
export const isDraft = (a: ArticleValue) => a.status === "DRAFT";
export const isPublished = (a: ArticleValue) => a.status === "PUBLISHED";
export const isApproved = (a: ArticleValue) => a.approvedAt !== null;
```

### preload を宣言する

preload は port を先に呼び、同じ実行内で結果を共有する指定です。check は宣言した port を分岐の中で直接呼ぶこともできます。

preload の宣言は、どの判定に属するか、名前、結果の型を持ちます。provider が Snapshot から引数を組み立てて port を呼びます。

たとえば、所有者ならその場で許可し、それ以外の場合だけ所属を調べる check は、所属照会の port を直接呼びます。照会して所属がなければ `violations`、照会自体が失敗したら `portFailed` です。

```ts
import { preload } from "domain-rules";

// 記事の保存の Snapshot から決まる、同じブログ内の記事一覧
export const articlesInBlog = preload(article.save, "articlesInBlog").of<readonly Article[]>();
```

名前は文字列リテラルの型として preload の型に残ります。同じ判定と同じ値の型を持つ preload でも、名前が違えば型で区別されます。

preload の判定と、それを使う rule の判定が違うと型エラーになります。保存の Snapshot から決まる preload は、`next` が `null` の削除の判定では使えないからです。

### rule を定義する

rule は1つの条件です。1つ目の引数に、どの判定の rule かを渡します。`requires` には preload、直接呼ぶ port、先行 rule を指定できます。`check` の2つ目の引数では、それぞれ preload の結果、呼び出せる port、先行 check の成功値を受け取ります。

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
  requires: { articlesInBlog },
  when: changed("slug"),
  check: (s, { articlesInBlog }) =>
    articlesInBlog.some((a) => a.slug === s.next.slug && a.id !== s.pre?.id)
      ? Result.fail("DUPLICATED_SLUG")
      : Result.succeed(),
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

`changed` の `pre` と `next` には、その項目の値か、その項目の値を受け取る述語を渡します。どちらも、値が変わったときだけ当たります。1つの項目の変化は `changed` で書き、複数の項目にまたがる条件は `pre(述語)` と `next(述語)` を `and` などで組み合わせて書きます。

actor を when に書くか check に書くかは、次のように分けます。

- **rule を当てるかどうかが、操作した人で変わる。** when に書きます。例えば「管理者以外が公開後に slug を変えたら違反」は、管理者のときには rule 自体が当たりません。
- **操作した人が条件を満たすかどうかが、rule の中身そのもの。** check に書きます。例えば「公開できるのは今のレビュアーだけ」は、公開という変化のときに当たり、レビュアーでなければ違反にします。

when の正体は `(s: Snapshot) => boolean` という関数で、`changed` や `next` などはこの関数を作る関数です。作る関数が返す when には、`{ kind: "changed", field: "status", pre: "DRAFT", next: "PUBLISHED" }` のような説明が付きます。実行前の plan はこの説明を使って適用条件を表示します。適用の有無は check の直前に、その時点の Snapshot で決まります。手書きの関数には、`describe("公開済みの記事", (s) => ...)` で説明を付けられます。

### model のルールの組を作る

model ごとに、ルールの組を1つ作ります。

```ts
import { always, entityRules, rule } from "domain-rules";

export const isMember = (actor: AppActor): actor is MemberActor =>
  actor.role === "MEMBER" || actor.role === "ADMIN";

const memberOnly = {
  name: "記事を変更できるのはメンバーだけ",
  when: always,
  check: ({ actor }: { actor: AppActor }) =>
    isMember(actor) ? Result.succeed({ actor }) : Result.fail("NOT_MEMBER"),
};

export const memberCanSave = rule(article.save, memberOnly);

export const articleRules = entityRules(article, {
  save: [
    memberCanSave,
    statusChangesAreAllowed,
    articleImmutableFields,
    authorIsNotReviewer,
    uniqueSlugInBlog,
    publishAtInFuture,
    onlyReviewerPublishes,
    onlyAuthorChangesReviewer,
    slugLockedAfterPublish,
    publishedIsApproved,
  ],
  delete: [rule(article.delete, memberOnly), onlyDraftIsDeletable],
});
```

- **`save`。** `article.save` の rule を並べます。`create`、`update`、`upsert` のどれで呼ばれても、この一覧から `when` が当たるものを判定します。
- **`delete`。** `article.delete` の rule を並べます。`delete` を書かなければ、その model は削除できません。束ねたあとに `delete` のメソッドが作られないからです。`save` も同じです。

認証済みの actor は呼び出し側が渡します。操作を許可しない場合、認可 rule が違反を返します。

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
import { action, actionRules, preload, rule, always } from "domain-rules";
import { isMember } from "./articleRules";

export const previewArticle = action({
  name: "previewArticle",
  input: v.object({ blogId: BlogIdSchema, articleId: ArticleIdSchema }),
});

// 入力から決まる記事
export const targetArticle = preload(previewArticle.decide, "targetArticle").of<Article>();

export const notArchived = rule(previewArticle.decide, {
  name: "アーカイブ済みの記事はプレビューできない",
  requires: { targetArticle },
  when: always,
  check: (_s, { targetArticle }) =>
    targetArticle.status !== "ARCHIVED" ? Result.succeed() : Result.fail("ARCHIVED"),
});

export const canPreview = rule(previewArticle.decide, {
  name: "プレビューできるのはメンバーの著者かレビュアーだけ",
  requires: { targetArticle },
  when: always,
  check: ({ actor }, { targetArticle }) =>
    isMember(actor) && (actor.id === targetArticle.authorId || actor.id === targetArticle.reviewerId)
      ? Result.succeed()
      : Result.fail("NOT_ALLOWED"),
});

export const previewArticleRules = actionRules(previewArticle, {
  rules: [notArchived, canPreview],
  output: { article: targetArticle },
});
```

`decide` は action を実行するメソッドです。すべての適用対象の check が成功すると、指定した取得結果や検証済みの値を `output` に沿って組み立て、`Decision` に封をします。成功として到達する全経路で `output` の参照先が揃う必要があります。`output` を省略した action は、判定の成功を `Decision<A, void>` で返します。

### 確かめた値を型に残す

`check` は成功時に検証済みの値を返せます。たとえば、存在を確認する port が返した ID を `check` の成功値に含めると、後続の check はその ID を昇格済みの型で受け取れます。ライブラリが依存順を組み立て、成功した check の結果を後続へ渡します。

`when` がある場合、実行して成功した経路では昇格後の型、スキップした経路では check に入る時点の型を引き継ぎます。後続の check が実行され得る経路すべてで要求する型が揃わなければ、ルールの組を定義するときに型エラーになります。

たとえば、記事の保存時に `reviewerId` を `UserId` から `UserIdExisted` に昇格させます。この例の model が要求する保存用の型は `Omit<ArticleValue, "reviewerId"> & { reviewerId: UserIdExisted }` です。`pre.reviewerId` もその型で読み込みます。存在確認の port `requireExistingUserId` は、ユーザーが存在すれば同じ ID を `UserIdExisted` として返します。

```ts
const reviewerIdExists = rule(article.save, {
  name: "レビュアーが存在する",
  requires: { requireExistingUserId },
  when: always,
  check: async ({ pre, next }, { requireExistingUserId }) => {
    if (pre && pre.reviewerId === next.reviewerId) {
      return Result.succeed({ next: { reviewerId: pre.reviewerId } });
    }

    return (await requireExistingUserId(next.reviewerId))
      .map((reviewerId) => ({ next: { reviewerId } }));
  },
});

const authorIsNotVerifiedReviewer = rule(article.save, {
  name: "著者とレビュアーは別の人",
  requires: { reviewer: reviewerIdExists },
  when: always,
  check: ({ next }, { reviewer }) => {
    const reviewerId: UserIdExisted = reviewer.next.reviewerId;
    return next.authorId !== reviewerId
      ? Result.succeed()
      : Result.fail("SAME_AUTHOR_AND_REVIEWER");
  },
});
```

保存ルール一覧では `reviewerIdExists` を追加し、`authorIsNotReviewer` を `authorIsNotVerifiedReviewer` に差し替えます。ライブラリは成功値の `next.reviewerId` を後続の check と保存時の `next` に渡します。作成時と ID を変更した更新では port が確かめた値を使い、同じ ID を使う更新では `pre` の値を引き継ぎます。どの成功経路でも `open(persistable).next.reviewerId` は `UserIdExisted` です。

actor も同じように昇格できます。先ほどの `memberCanSave` は、会員条件を確かめてから成功値として `{ actor }` を返します。レビュアーを変更できる人を調べる check では、この成功値を `requires` に指定します。

```ts
const onlyMemberAuthorChangesReviewer = rule(article.save, {
  name: "作成後にレビュアーを変えられるのは著者だけ",
  requires: { member: memberCanSave },
  when: and(not(onCreate), changed("reviewerId")),
  check: ({ pre }, { member }) => {
    const actor: MemberActor = member.actor;
    return actor.id === pre?.authorId
      ? Result.succeed()
      : Result.fail("NOT_AUTHOR");
  },
});
```

この例では、保存ルール一覧の `onlyAuthorChangesReviewer` を `onlyMemberAuthorChangesReviewer` に差し替えます。ライブラリは `memberCanSave` を先に実行し、成功値を `member` として渡します。もし `memberCanSave` が更新時にスキップされる条件だった場合、更新時にもこの後続 check が当たり得るため、ルールの組の定義が型エラーになります。

更新では、省略された項目を保存済みの `pre` からその型のまま引き継ぎます。`Persistable` を返すには、成功として到達するすべての経路で保存用の型が揃っている必要があります。

### provider を定義して束ねる

provider は、宣言された port の実装です。preload、model の port(`load` と `newId`)、時計のどれでも、同じ `provide` で渡します。ドメインの外で定義します。

```ts
import { preload, provide, bind, clock } from "domain-rules";
import { article, articlesInBlog, articleRules, previewArticle, previewArticleRules, targetArticle } from "@example/domain";

// provider の中だけで使う preload。ドメインの rule からは見えなくてよい
const blog = preload(article.save, "blog").of<Blog>();

export const providers = [
  provide(article.load, (key) => articleRepository.find(key.blogId, key.id)),
  provide(article.newId, () => createArticleId()),
  provide(blog, (s) => blogRepository.findById(s.next.blogId)),
  provide(articlesInBlog, {
    requires: { blog },
    load: (_s, { blog }) => articleRepository.findByBlog(blog.id),
  }),
  provide(targetArticle, (s) => articleRepository.find(s.input.blogId, s.input.articleId)),
  provide(clock, () => Date.now()),
] as const;

export const domain = bind([articleRules, previewArticleRules], { providers });
// {
//   article: { create, update, upsert, delete },
//   previewArticle: { decide },
// }
```

provider は他の preload を使って取得することもできます。preload 同士の依存は「どう取るか」の都合なので、宣言ではなく provider の側に書きます。

provider の一覧は、`as const` を付けた読み取り専用のタプルにします。普通の配列だと、要素を1つ消しても配列の型が変わらず、provider の不足を型で検出できないからです。

`bind` は起動時に1回だけ呼びます。provider の確認は2段階で行います。

- **型での確認。** ルールの組が必要とする port のうち、provider の一覧にないものがあれば型エラーにします。
- **起動時の確認。** provider の requires をたどった依存のつながりについて、不足、同じ port の重複、循環を確かめ、見つかればエラーにします。型だけでは、つながりの全体を確かめきれないからです。

テストでは、固定の値を返す provider で束ねるだけで済みます。repository の mock はいりません。

```ts
const testDomain = bind([articleRules], {
  providers: [
    provide.value(article.load, existingArticle),
    provide.value(article.newId, "art_1" as ArticleId),
    provide.value(articlesInBlog, []),
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

`input` は、schema の入力の型を `Partial` にしたものです。`upsert` は、`key` がなければ新規作成、`key` があって既存の値が見つかれば更新、`key` があって見つからなければ `notFound` を返します。呼び出す側が id を決めて新規作成する使い方は、まだ扱いません(未決定の論点を参照)。

### 返り値は封をした値

メソッドが返す `Persistable`、`Deletable`、`Decision` は、中身を直接持たない、封をした値です。中身は `open` で取り出します。

```ts
import { open } from "domain-rules";

const save = (p: Persistable<typeof article, "create" | "update">) => {
  const { pre, next, actor } = open(p);
  // pre: Readonly<Article> | null。create なら null、update なら Readonly<Article>
  // next: Readonly<Article>。check の成功値から得た保存用の型
  ...
};
```

| 返り値 | `open` で取り出せるもの |
|---|---|
| `Persistable<M, "create">` | `pre: null`、`next`、`actor` |
| `Persistable<M, "update">` | `pre`(変更前の値)、`next`、`actor` |
| `Deletable<M>` | `pre`(削除する対象)、`actor` |
| `Decision<A, T>` | `value`(`output` で指定した値。省略時は `undefined`)、`actor` |

封をした値にするのは、証明を別の値や別の操作に付け替えられないようにするためです。

- **型。** 返り値の型は、操作の種類と対象を型引数に持ちます。`Persistable` を `Deletable` として渡すと型エラーになります。
- **中身の書き換え。** `open` が返す値は読み取り専用で、実行時にも凍結されています。
- **作り直し。** 封をした値をスプレッドなどで作り直したものは、`open` が受け付けずにエラーになります。中身は、メソッドが作った値そのものに結び付けて、ライブラリの中だけで持っているからです。

`actor` は、呼び出し側が渡した actor です。

失敗したときの型は次のとおりです。

```ts
type CheckError =
  | { kind: "invalid"; issues: SchemaIssue[] }            // キー、入力、未知の項目が schema を満たさない
  | { kind: "notFound" }                                  // キーに対応する既存の値がない
  | { kind: "violations"; violations: RuleViolation[] }   // check がルール違反を返した
  | { kind: "portFailed"; port: string; cause: unknown }; // provider が失敗した、または不正な値を返した
```

## 実行モデル

束ねたメソッドは、呼ばれるたびに次の段階で進みます。

| 段階 | やること | 責任を持つ部品 | 失敗したとき |
|---|---|---|---|
| 1. 受け取る | actor を受け取り、キーと入力を schema で検証する | model と action の schema | `invalid` |
| 2. resolve | キーから既存の値を取る | `model.load` の provider | `notFound`、`portFailed` |
| 3. merge | 既存の値に、検証済みの入力を重ねて next を作る | ライブラリ | なし |
| 4. plan | rule と `output` の依存を調べ、実行順を組み立てる | rule の `when` と `requires`、`output` の参照先 | なし |
| 5. load | check や output に必要な preload を実行する | preload の provider | `portFailed` |
| 6. check | 各 check の直前に when を評価し、当たる check を実行する | rule の `when` と `check` | `violations`、`portFailed` |
| 7. output | 成功時に返す値を組み立てる(action だけ) | ライブラリ | なし |
| 8. seal | id を付け、封をした値を作る | `model.newId` の provider | `portFailed` |

- **受け取る。** 入力は、入力にある項目だけを、その項目の schema で検証します。schema にない項目が入っていたら `invalid` を返します。`create` では、入力全体を schema で検証し、既定値を入れます。
- **merge。** 既存の値も入力も、schema の出力の形にそろえてから重ねます。入力で `undefined` の項目は既存の値を残し、`null` の項目は `null` で上書きします。既存の値は、provider が正しい形で返す前提で、もう一度は検証しません。
- **load と check。** 互いに依存しない preload は並列に取得します。同じ preload は1回の実行の中で1回だけ取得し、rule と `output` で共有します。違反が出た check の成功値に依存する後続は実行できません。前提が揃っている check は続け、実行した check の違反を集めて返します。
- **seal。** 保存では id を付けます(更新なら既存の id、新規なら `model.newId` の provider で作った id)。`newId` が失敗するか、id の schema を満たさない値を返したら `portFailed` を返します。

メソッドによって、通らない段階があります。

- **`create`。** resolve を行いません。
- **`delete`。** merge を行いません。
- **`decide`。** resolve と merge を行いません。受け取る段階で、入力の全体を action の入力の schema で検証します。

`plan` は単体でも呼べるので、「どの rule が候補で、何に依存し、どの順で実行するか」をテストやデバッグで確かめられます。

```ts
plan(articleRules, snapshot);
// { rules: ["著者とレビュアーは別の人", "公開できるのは今のレビュアーだけ", ...], preloads: [] }
```

## データ取得の方針

- **重複除去。** 同じ preload を複数の rule が必要とするときは、1回だけ取得します。同一性の基準は preload の宣言オブジェクトそのものです。
- **batch。** 同じ種類で引数だけ違う取得をまとめる機能は、将来の課題です。
- **リクエストをまたぐキャッシュ。** 行いません。rule は最新のデータで判定する前提なので、古い値で判定が通ると不正なデータが保存されます。

## 設計原則

- **ルールの組は対象と1対1。** 操作ごとにルールの組を作りません。どのルールが当たるかは `when` が値の変化から決めます。一覧に登録した rule は、操作ごとに登録し直す必要がありません。
- **小さな単位で定義する。** model、action、preload、rule は1つずつ独立した値です。
- **境界で受け取り、中では信じる。** キーと入力は最初の段階で検証します。actor は呼び出し側で認証し、操作の認可は rule で判定します。
- **副作用はすべて port。** preload や check から呼ぶ port、既存の値の取得、id の生成、時計の実装は、`provide` で注入します。
- **値の形は schema、項目をまたぐ条件は rule。** schema は項目ごとの形を表し、更新では入力にある項目だけを検証します。項目をまたぐ条件は rule に書くので、更新のたびに値の全体を検証し直す必要はありません。
- **マージの規則は1つにする。** `undefined` は「変えない」、`null` は「空にする」です。
- **判定の種類を値で渡す。** rule と preload は、`article.save` のような値で判定の種類を受け取ります。種類の違うものを組み合わせると型エラーになり、型引数を明示しなくても型が推論されます。
- **`requires` は静的に宣言する。** 依存を実行前に知ることができるので、plan による最適化と説明ができます。
- **ライブラリは状態を知らない。** rule が見るのは pre と next の値の変化だけです。
- **`when` は同期の純関数にする。** `check` は宣言した port を必要な分岐で呼べます。
- **check は判定結果と検証済みの値を返せる。** action が返す値は `output` で指定します。
- **返り値は封をした値。** 証明は、メソッドが作った値そのものに結び付きます。別の値や別の操作に付け替えることはできません。

## スコープ外

- **永続化。** `Persistable` や `Deletable` を受け取って保存・削除するのは利用する側の責務です。
- **並行実行での整合性(TOCTOU)。** 一意性などは DB の制約と併用してください。
- **複数の値をまとめて変更する操作。** 1回の呼び出しで扱うのは1つの値です。同じ操作の中で複数の値の入れ替えを判定する、といった使い方は扱いません。
- **API ごとの入力の形。** 「この API からは status しか受け取らない」のような制限は、usecase が受け取る型を狭めて行います。「status を変えられるのはレビュアーだけ」のようなドメインの制限は、rule として書きます。
- **通信の形からの変換。** GraphQL や HTTP の型を、メソッドの引数に詰め替えるのは利用する側の責務です。
- **時間経過による自動遷移やワークフローの実行。**

## 先行事例

- **Haxl**(Facebook)。ルールが使うデータの取得を自動で重複除去・batch・並列化する Haskell ライブラリです。論文は "There is no Fork"(ICFP 2014)。
- **Build Systems à la Carte**(ICFP 2018)。依存を静的に宣言するタスク(Applicative)は、実行前に最適化できます。`requires` を静的にする根拠です。
- **Ports and Adapters と Effect の `Context.Tag`**。必要なものを型付きの宣言として表し、実装は外から注入する考え方です。port と provider の関係がこれにあたります。
- **Event-B と Design by Contract**。不変条件と遷移のガードを分けて書く考え方です。
- **Parse, don't validate**(Alexis King)。検証が通ったら、より強い型に変える考え方です。境界での検証と、check が返す検証済みの値と、封をした返り値がこれにあたります。
- **Standard Schema**。schema ライブラリに共通のインターフェースです。action の入力の schema は、これに対応したものを使えます。

## 未決定の論点

- **型での provider の確認がどこまで成り立つか。** ルールの組の一覧と provider のタプルから、必要な port の不足を推論できるかは、まだ試していません。
- **呼び出す側が決めた id での新規作成。** `upsert` で、指定したキーが見つからないときに、そのキーで作成する使い方は扱っていません。
- **入れ子の値のマージ。** 今の規則は1段目の項目だけを重ねます。
- **preload に引数を持たせるか。** 今は Snapshot から決まる値だけを扱います。「next の blog」と「pre の blog」のように対象が違うものは、別の preload として宣言します。
- **actor の型の登録方法。** 今は `Register` への型の登録(module augmentation)で、アプリケーション全体で1つの actor の型を使う想定です。
- **条件付き昇格の型推論。** 実行とスキップの両経路を宣言 API から推論し、後続の check と保存用の型を検査する仕組みは、型の試作で確認します。

## License

未定
