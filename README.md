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
| action | action ごとに1つ。判定のルールと、値を決める `decide` を持つ | `decide` |

新規作成か更新かは、ルールの違いではなく呼び出し方の違いです。そのため、同じ保存のルールが `create`、`update`、`upsert` のどれにも当たります。

### 部品と責務

| 部品 | 責務 | 持つもの |
|---|---|---|
| model | エンティティの形と、取り出し方 | 値の schema、id の schema、取得のキーの schema、port の宣言(キーから取る、新しい id を作る) |
| action | 保存を伴わない操作の入力の形 | 入力の schema |
| rule | 1つの条件 | `requires`、`when`、`check`、`refines` |
| relation | 判定に必要なデータの宣言 | 名前、どの判定の Snapshot から決まるか、型 |
| entityRules | model のルールの組 | 受け付ける actor の型ガード、保存のルール、削除のルール |
| actionRules | action のルールの組 | 受け付ける actor の型ガード、判定のルール、`decide` |
| provider | 宣言された port の実装 | relation、model の port、時計のどれか1つの実装 |
| bind | ルールの組と provider を束ね、呼び出せるメソッドを作る | なし |

成功と失敗は [@praha/byethrow](https://github.com/praha-inc/byethrow) の `Result` で表します。rule の `check` は `Result`、provider と、束ねたあとのメソッドは `ResultAsync`(`Promise<Result>`)を返します。

### 定義する場所

| 段階 | 場所 | やること |
|---|---|---|
| 組む | ドメインのパッケージ | model、action、relation、rule を定義し、対象ごとにルールの組を作って公開する |
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

rule と relation は、どの判定に属するかを値で受け取ります。判定は3種類あり、それぞれ受け取る Snapshot の形が違います。

| 判定 | 書き方 | Snapshot |
|---|---|---|
| model の保存 | `article.save` | `{ pre: Entity \| null, next: Value, actor, now }` |
| model の削除 | `article.delete` | `{ pre: Entity, next: null, actor, now }` |
| action の判定 | `previewArticle.decide` | `{ input, actor, now }` |

- `pre` は変更前の値です。新規作成のときは `null` です。
- `next` は変更後の値です。既存の値に入力を重ねたものです。
- `now` は呼び出された時刻で、1回の実行の中では同じ値です。

判定の種類を値で渡すのは、TypeScript が型引数の一部だけを明示して残りを推論することができないからです。rule の型引数に Snapshot の型を明示すると、`requires` から `check` の引数の型を推論できなくなります。値で渡せば、Snapshot の型も `requires` の型も、すべて引数から推論されます。

rule の中で、絞った型の actor を前提にしたいときは、判定の種類に actor の型を付けます。

```ts
article.save.withActor<MemberActor>()
```

ライブラリは「状態」という概念を持ちません。「下書き」「承認済み」のような判断は、値についての述語としてドメインの側に書きます。述語はただの関数で、ライブラリに登録する必要はありません。

```ts
export const isDraft = (a: ArticleValue) => a.status === "DRAFT";
export const isPublished = (a: ArticleValue) => a.status === "PUBLISHED";
export const isApproved = (a: ArticleValue) => a.approvedAt !== null;
```

### relation を宣言する

relation は「この判定には、こういうデータが必要だ」という宣言です。どの判定に属するかと、名前と、型だけを持ちます。取得方法は持ちません。

```ts
import { relation } from "domain-rules";

// 記事の保存の Snapshot から決まる、同じブログ内の記事一覧
export const articlesInBlog = relation(article.save, "articlesInBlog").of<readonly Article[]>();
```

名前は文字列リテラルの型として relation の型に残ります。同じ判定と同じ値の型を持つ relation でも、名前が違えば型で区別されます。

relation の判定と、それを使う rule の判定が違うと型エラーになります。保存の Snapshot から決まる relation は、`next` が `null` の削除の判定では使えないからです。

### rule を定義する

rule は1つの条件です。1つ目の引数に、どの判定の rule かを渡します。`requires` には relation そのものを渡し、`check` の2つ目の引数で受け取ります。

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

when の正体は `(s: Snapshot) => boolean` という関数で、`changed` や `next` などはこの関数を作る関数です。作る関数が返す when には、`{ kind: "changed", field: "status", pre: "DRAFT", next: "PUBLISHED" }` のような説明が付きます。plan はこれを使って「なぜこの rule が当たったか」を表示します。手書きの関数には、`describe("公開済みの記事", (s) => ...)` で説明を付けられます。

### model のルールの組を作る

model ごとに、ルールの組を1つ作ります。

```ts
import { entityRules } from "domain-rules";

const isMember = (a: AppActor): a is MemberActor => a.role === "MEMBER" || a.role === "ADMIN";

export const articleRules = entityRules(article, {
  actor: isMember,
  save: [
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
  delete: [onlyDraftIsDeletable],
});
```

- **`save`。** `article.save` の rule を並べます。`create`、`update`、`upsert` のどれで呼ばれても、この一覧から `when` が当たるものを判定します。
- **`delete`。** `article.delete` の rule を並べます。`delete` を書かなければ、その model は削除できません。束ねたあとに `delete` のメソッドが作られないからです。`save` も同じです。
- **`actor`。** この model を操作できる actor の型ガードです。省略すると、どの actor でも受け付けます。

`actor` の型ガードは、キーや入力の検証と同じく、呼び出しを受け取る境界での検証です。満たさなければ、何も取得せずに `forbidden` を返します。通った actor は、このルールの組のすべての rule、provider、返り値で、型ガードの型(この例では `MemberActor`)になります。`article.save.withActor<MemberActor>()` で作った rule を、actor を `MemberActor` に絞らないルールの組に入れると型エラーになります。

型ガードそのものが正しいことと、actor を作る認証の処理が正しいことは、利用する側の責任です。ライブラリは、型ガードが返した結果を信じます。

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
import { action, actionRules, relation, rule, always } from "domain-rules";

export const previewArticle = action({
  name: "previewArticle",
  input: v.object({ blogId: BlogIdSchema, articleId: ArticleIdSchema }),
});

// 入力から決まる記事
export const targetArticle = relation(previewArticle.decide, "targetArticle").of<Article>();

export const notArchived = rule(previewArticle.decide, {
  name: "アーカイブ済みの記事はプレビューできない",
  requires: { targetArticle },
  when: always,
  check: (_s, { targetArticle }) =>
    targetArticle.status !== "ARCHIVED" ? Result.succeed() : Result.fail("ARCHIVED"),
});

export const previewArticleRules = actionRules(previewArticle, {
  actor: isMember,
  rules: [notArchived],
  decide: {
    requires: { targetArticle },
    decide: (s, { targetArticle }) =>
      s.actor.id === targetArticle.authorId
        ? Result.succeed({ article: targetArticle, viewerRole: "author" as const })
        : s.actor.id === targetArticle.reviewerId
          ? Result.succeed({ article: targetArticle, viewerRole: "reviewer" as const })
          : Result.fail("NOT_ALLOWED"),
  },
});
```

`decide` は、すべての rule を通ったあとに1回だけ呼ばれ、返す値を決めます。rule は合否だけを返し、値を決めるのは `decide` だけです。`decide` の `requires` も、rule の `requires` と同じく plan の段階で集めて取得します。`decide` が失敗を返したら、rule の違反と同じく `violations` になります。

### 確かめた値を型に残す

rule の `refines` に書いた項目は、rule を通ったあと、返り値の変更後の値(`next`)で brand 付きの型になります。値そのものは変わりません。

```ts
import { brand, exists } from "domain-rules";

// 前の例の uniqueSlugInBlog に refines を足したもの。when は always にする
export const uniqueSlugInBlog = rule(article.save, {
  name: "slug はブログ内で一意",
  requires: { articlesInBlog },
  when: always,
  check: (s, { articlesInBlog }) =>
    articlesInBlog.some((a) => a.slug === s.next.slug && a.id !== s.pre?.id)
      ? Result.fail("DUPLICATED_SLUG")
      : Result.succeed(),
  refines: { slug: brand<"UniqueInBlog">() },
});

// relation が null でなければ通り、blogId を Existed<BlogId> にする rule を作る
export const blogOfArticle = relation(article.save, "blogOfArticle").of<Blog | null>();
export const blogExists = exists(blogOfArticle, "blogId");
```

- **when は `always` に限る。** 当たらないことがある rule だと、当たらなかったときにも型が強くなってしまい、型が嘘になるからです。`always` 以外の when と `refines` を一緒に書くと型エラーになります。
- **強くなるのは、返り値の変更後の値だけ。** 変更前の値(`pre`)は検査していないので強くなりません。同じルールの組のほかの rule が見る Snapshot も強くなりません。rule の判定は互いに順序を持たないので、ほかの rule の結果を前提にできないからです。
- **`refines` は宣言。** `refines` は「この rule の check は、この項目についてこれを確かめた」という宣言で、check の中身と一致しているかをライブラリは確かめません。`exists` のように、check と refines を一緒に作る関数を使えば、食い違いは起きません。

actor の型の絞り込みは、ここではなく、ルールの組の `actor` で行います。actor の型ガードは境界での検証で、rule の結果ではないからです。

### provider を定義して束ねる

provider は、宣言された port の実装です。relation、model の port(`load` と `newId`)、時計のどれでも、同じ `provide` で渡します。ドメインの外で定義します。

```ts
import { relation, provide, bind, clock } from "domain-rules";
import { article, articlesInBlog, articleRules, previewArticle, previewArticleRules, targetArticle } from "@example/domain";

// provider の中だけで使う relation。ドメインの rule からは見えなくてよい
const blog = relation(article.save, "blog").of<Blog>();

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

provider は他の relation を使って取得することもできます。relation 同士の依存は「どう取るか」の都合なので、宣言ではなく provider の側に書きます。

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
  // next: Readonly<Article>。refines で強くなった型を含む
  ...
};
```

| 返り値 | `open` で取り出せるもの |
|---|---|
| `Persistable<M, "create">` | `pre: null`、`next`、`actor` |
| `Persistable<M, "update">` | `pre`(変更前の値)、`next`、`actor` |
| `Deletable<M>` | `pre`(削除する対象)、`actor` |
| `Decision<A, T>` | `value`(`decide` が返したもの)、`actor` |

封をした値にするのは、証明を別の値や別の操作に付け替えられないようにするためです。

- **型。** 返り値の型は、操作の種類と対象を型引数に持ちます。`Persistable` を `Deletable` として渡すと型エラーになります。
- **中身の書き換え。** `open` が返す値は読み取り専用で、実行時にも凍結されています。
- **作り直し。** 封をした値をスプレッドなどで作り直したものは、`open` が受け付けずにエラーになります。中身は、メソッドが作った値そのものに結び付けて、ライブラリの中だけで持っているからです。

`actor` は、ルールの組の `actor` の型ガードで絞った型です。

失敗したときの型は次のとおりです。

```ts
type CheckError =
  | { kind: "forbidden" }                                 // actor が型ガードを満たさない
  | { kind: "invalid"; issues: SchemaIssue[] }            // キー、入力、未知の項目が schema を満たさない
  | { kind: "notFound" }                                  // キーに対応する既存の値がない
  | { kind: "violations"; violations: RuleViolation[] }   // rule か decide が失敗した
  | { kind: "portFailed"; port: string; cause: unknown }; // provider が失敗した、または不正な値を返した
```

## 実行モデル

束ねたメソッドは、呼ばれるたびに次の段階で進みます。

| 段階 | やること | 責任を持つ部品 | 失敗したとき |
|---|---|---|---|
| 1. 受け取る | actor を型ガードで確かめ、キーを key の schema で、入力を項目ごとに検証する | ルールの組の `actor`、model と action の schema | `forbidden`、`invalid` |
| 2. resolve | キーから既存の値を取る | `model.load` の provider | `notFound`、`portFailed` |
| 3. merge | 既存の値に、検証済みの入力を重ねて next を作る | ライブラリ | なし |
| 4. plan | 当たる rule と、rule と `decide` が必要とする relation を決める | rule の `when` と `requires`、`decide` の `requires` | なし |
| 5. load | plan で決めた relation を取る | relation の provider | `portFailed` |
| 6. check | 当たる rule を判定する | rule の `check` | `violations` |
| 7. decide | 返す値を決める(action だけ) | action の `decide` | `violations` |
| 8. seal | id を付け、封をした値を作る | `model.newId` の provider | `portFailed` |

- **受け取る。** 入力は、入力にある項目だけを、その項目の schema で検証します。schema にない項目が入っていたら `invalid` を返します。`create` では、入力全体を schema で検証し、既定値を入れます。
- **merge。** 既存の値も入力も、schema の出力の形にそろえてから重ねます。入力で `undefined` の項目は既存の値を残し、`null` の項目は `null` で上書きします。既存の値は、provider が正しい形で返す前提で、もう一度は検証しません。
- **load と check。** 互いに依存しない relation は並列に取得します。同じ relation は1回の実行の中で1回だけ取得し、rule と `decide` で共有します。rule は最初の違反で止めず、`Result.collect` で違反をすべて集めて返します。
- **seal。** 保存では id を付けます(更新なら既存の id、新規なら `model.newId` の provider で作った id)。`newId` が失敗するか、id の schema を満たさない値を返したら `portFailed` を返します。

メソッドによって、通らない段階があります。

- **`create`。** resolve を行いません。
- **`delete`。** merge を行いません。
- **`decide`。** resolve と merge を行いません。受け取る段階で、入力の全体を action の入力の schema で検証します。

`plan` は単体でも呼べるので、「どの rule が当たり、何が必要か」をテストやデバッグで確かめられます。

```ts
plan(articleRules, snapshot);
// { rules: ["著者とレビュアーは別の人", "公開できるのは今のレビュアーだけ", ...], relations: [] }
```

## データ取得の方針

- **重複除去。** 同じ relation を複数の rule が必要とするときは、1回だけ取得します。同一性の基準は relation の宣言オブジェクトそのものです。
- **batch。** 同じ種類で引数だけ違う取得をまとめる機能は、将来の課題です。
- **リクエストをまたぐキャッシュ。** 行いません。rule は最新のデータで判定する前提なので、古い値で判定が通ると不正なデータが保存されます。

## 設計原則

- **ルールの組は対象と1対1。** 操作ごとにルールの組を作りません。どのルールが当たるかは `when` が値の変化から決めます。ルールの並べ忘れで、ある操作だけ検査が抜けることはありません。
- **小さな単位で定義する。** model、action、relation、rule は1つずつ独立した値です。
- **境界で受け取り、中では信じる。** actor、キー、入力は最初の段階で検証します。通ったあとは、すべての rule と provider がその型を信じます。
- **副作用はすべて port。** relation、既存の値の取得、id の生成、時計は、どれも宣言された port で、どれも `provide` で注入します。
- **値の形は schema、項目をまたぐ条件は rule。** schema は項目ごとの形を表し、更新では入力にある項目だけを検証します。項目をまたぐ条件は rule に書くので、更新のたびに値の全体を検証し直す必要はありません。
- **マージの規則は1つにする。** `undefined` は「変えない」、`null` は「空にする」です。
- **判定の種類を値で渡す。** rule と relation は、`article.save` のような値で判定の種類を受け取ります。種類の違うものを組み合わせると型エラーになり、型引数を明示しなくても型が推論されます。
- **`requires` は静的に宣言する。** 依存を実行前に知ることができるので、plan による最適化と説明ができます。
- **ライブラリは状態を知らない。** rule が見るのは pre と next の値の変化だけです。
- **`when` と `check` は同期の純関数にする。** 関連データを見ないと決まらない条件は、`check` の中で「当てはまらなければ ok」として書きます。
- **rule は合否だけを返す。** 値を決めるのは action の `decide` だけです。
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
- **Parse, don't validate**(Alexis King)。検証が通ったら、より強い型に変える考え方です。境界での検証と、`refines` と、封をした返り値がこれにあたります。
- **Standard Schema**。schema ライブラリに共通のインターフェースです。action の入力の schema は、これに対応したものを使えます。

## 未決定の論点

- **取得したデータによって、次の取得を選ぶ。** 「対象の所有者なら追加の照会なしで許可し、そうでなければ所属を調べる」のように、先に取ったデータで次に取るかどうかが決まる判定があります。今は必要な relation をすべて先に取得するので、所有者でも所属の照会が走り、その照会が失敗すると判定も失敗します。依存を静的に保ったまま分岐できる Selective Applicative Functors(ICFP 2019)の考え方を入れるか、別の方法をとるかを決めていません。
- **型での provider の確認がどこまで成り立つか。** ルールの組の一覧と provider のタプルから、必要な port の不足を推論できるかは、まだ試していません。
- **呼び出す側が決めた id での新規作成。** `upsert` で、指定したキーが見つからないときに、そのキーで作成する使い方は扱っていません。
- **入れ子の値のマージ。** 今の規則は1段目の項目だけを重ねます。
- **relation に引数を持たせるか。** 今は Snapshot から決まる値だけを扱います。「next の blog」と「pre の blog」のように対象が違うものは、別の relation として宣言します。
- **actor の型の登録方法。** 今は `Register` への型の登録(module augmentation)で、アプリケーション全体で1つの actor の型を使う想定です。
- **保存で値を決める。** 今の `decide` は action だけが持ちます。
- **`refines` の型の計算。** 複数の rule の `refines` を合わせて返り値の型を作る計算が、rule の数が増えても実用的な速さで終わるかは試していません。

## License

未定
