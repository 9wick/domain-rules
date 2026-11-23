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

```
model       = id の schema + 値の schema + pre(既存の値を取る relation)
relation    = 名前 + 型。「何が必要か」の宣言だけで、取得方法は持たない
rule        = requires(使う relation) + when(適用する条件) + check(判定)
ruleSet     = model + rule の組。1つの操作で守るべきルールの一覧
provider    = relation の取得方法、または model の id の生成方法
checker     = ruleSet + provider + 時計。コマンドを受け取って検証する関数
persistable = pre(変更前) + value(id 付きの変更後) + 「適用されたすべての rule を通った」証明
```

schema は値の形と検証の規則で、これもドメインの知識です。そのため model は schema を持ち、ドメインのパッケージに置きます。schema には Valibot など、[Standard Schema](https://standardschema.dev) を実装したライブラリを使えます。

成功と失敗は [@praha/byethrow](https://github.com/praha-inc/byethrow) の `Result` で表します。rule の `check` は `Result`、provider と checker は `ResultAsync`(`Promise<Result>`)を返します。

定義する場所と時期は、次の3段階に分かれます。

| 段階 | 場所 | やること |
|---|---|---|
| 組む | ドメインのパッケージ | model と relation を宣言し、rule を定義し、操作ごとに ruleSet にまとめて公開する |
| 束ねる | アプリケーションの組み立て部分(DI の設定) | 名前を付けた ruleSet の一覧に provider と時計を渡し、checker の一覧を作る |
| 実行する | usecase | checker にコマンドを渡す |

ドメインのパッケージは model、relation、rule、ruleSet だけを公開し、repository や DB を一切知りません。

## 使用例(構想)

ブログ記事を題材にします。

### model を定義する(ドメインのパッケージ)

```ts
import * as v from "valibot";
import { model, type Entity, type Value } from "domain-rules";

export const ArticleIdSchema = v.pipe(v.string(), v.startsWith("art_"), v.brand("ArticleId"));

export const article = model({
  name: "article",
  id: ArticleIdSchema,
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

// schema の出力の型。id を持たない
export type ArticleValue = Value<typeof article>;
// { id: ArticleId } と ArticleValue を合わせたもの
export type Article = Entity<typeof article>;
```

`article.pre` と `article.newId` は model が自動で持つ宣言です。`article.pre` は「id から既存の記事を取る」、`article.newId` は「新しい id を1つ作る」という意味です。どちらも、取得方法は relation と同じく provider として後から注入します。

作成時の既定値は schema に書きます。新規作成のときは pre がないので、入力にない項目には schema の既定値が入ります。更新のときは pre の値が入るので、既定値は使われません。

### relation を宣言する

relation は「この操作の判定には、こういうデータが必要だ」という宣言です。名前と型だけを持ち、取得方法は持ちません。

```ts
import { relation } from "domain-rules";

// Snapshot<Article> から決まる、同じブログ内の記事一覧
export const articlesInBlog = relation<Article, readonly Article[]>("articlesInBlog");
```

### rule を定義する

rule は1つのルールで、`Snapshot` についての条件です。ここでは保存の rule(`saveRule` で作るもの)を例にします。削除と判定の rule は、「操作の種類を選ぶ」の節で扱います。

```ts
type Snapshot<S extends { id: unknown }> = {
  pre: S | null;          // 変更前。新規作成のときは null
  next: Omit<S, "id">;    // 変更後。入力を pre にマージし、schema で検証したもの
  actor: Actor;           // 操作した人。型はアプリケーションが決める(後述)
  now: number;            // checker が呼ばれた時刻。1回の実行の中では同じ値
};
```

ライブラリは「状態」という概念を持ちません。どの項目が状態なのかを、ライブラリは知りません。rule が見るのは、pre と next という2つの値の変化だけです。「下書き」「承認済み」のような判断は、値についての述語(`(value) => boolean` の関数)としてドメインの側に書きます。

```ts
export const isDraft = (a: ArticleValue) => a.status === "DRAFT";
export const isPublished = (a: ArticleValue) => a.status === "PUBLISHED";
export const isApproved = (a: ArticleValue) => a.approvedAt !== null;
```

述語はただの関数です。ライブラリに登録する必要はなく、1つの項目を見ても、複数の項目を組み合わせてもかまいません。

`requires` には relation そのものを渡します。文字列の名前を使わないので、`check` の引数の型は自動で決まり、宣言していない relation は使えません。

```ts
import { saveRule, always, changed, next, pre, actor, and, not } from "domain-rules";
import { Result } from "@praha/byethrow";

export const authorIsNotReviewer = saveRule<Article>({
  name: "著者とレビュアーは別の人",
  when: always,
  check: (s) =>
    s.next.authorId !== s.next.reviewerId
      ? Result.succeed()
      : Result.fail("SAME_AUTHOR_AND_REVIEWER"),
});

export const uniqueSlugInBlog = saveRule<Article>({
  name: "slug はブログ内で一意",
  requires: { articlesInBlog },
  when: changed("slug"),
  check: (s, { articlesInBlog }) =>
    articlesInBlog.some((a) => a.slug === s.next.slug && a.id !== s.pre?.id)
      ? Result.fail("DUPLICATED_SLUG")
      : Result.succeed(),
});

export const publishAtInFuture = saveRule<Article>({
  name: "公開日時は未来",
  when: changed("publishAt"),
  check: (s) =>
    s.next.publishAt > s.now ? Result.succeed() : Result.fail("PUBLISH_AT_IN_PAST"),
});

export const onlyReviewerPublishes = saveRule<Article>({
  name: "公開できるのはレビュアーだけ",
  when: changed("status", { pre: "DRAFT", next: "PUBLISHED" }),
  check: (s) =>
    s.actor.id === s.next.reviewerId ? Result.succeed() : Result.fail("NOT_REVIEWER"),
});

// 公開後の slug は管理者しか変えられない
export const slugLockedAfterPublish = saveRule<Article>({
  name: "公開後の slug を変えられるのは管理者だけ",
  when: and(changed("slug"), pre(isPublished), not(actor(isAdmin))),
  check: () => Result.fail("SLUG_LOCKED"),
});

export const publishedIsApproved = saveRule<Article>({
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

export const statusChangesAreAllowed = saveRule<Article>({
  name: "status は許可された変化だけ",
  when: changed("status"),
  check: (s) => {
    const allowed = s.pre === null ? ["DRAFT"] : allowedStatusChanges[s.pre.status];
    return allowed.includes(s.next.status)
      ? Result.succeed()
      : Result.fail("STATUS_CHANGE_NOT_ALLOWED");
  },
});
```

`when` の種類は次のとおりです。

| 種類 | when |
|---|---|
| 常に | `always` |
| 新規作成のとき | `onCreate` |
| 項目の値が変わったとき | `changed("slug")`。新規作成のときも満たす |
| 項目の値が、ある値から変わったとき | `changed("status", { pre: "DRAFT" })`。新規作成のときは満たさない |
| 項目の値が、ある値に変わったとき | `changed("status", { next: "PUBLISHED" })`。新規作成でその値から始まるときも満たす |
| 項目の値が、ある値からある値に変わったとき | `changed("status", { pre: "DRAFT", next: "PUBLISHED" })` |
| 変更後の値が述語を満たすとき | `next(isPublished)` |
| 変更前の値が述語を満たすとき | `pre(isDraft)`。新規作成のときは満たさない |
| 操作した人が述語を満たすとき | `actor(isAdmin)`、`actor((a, s) => a.id === s.next.authorId)` |
| 組み合わせ | `and(...)`、`or(...)`、`not(...)` |
| 独自の条件 | `(s) => boolean` の関数をそのまま渡す |

`changed` の `pre` と `next` には、その項目の値か、その項目の値を受け取る述語を渡します。`changed("publishAt", { next: (t) => t > 0 })` のように書けます。どちらも、値が変わったときだけ当たります。`pre` も `next` も同じ値のままなら、`changed` は当たりません。

`actor` には、操作した人を受け取る述語を渡します。述語の2つ目の引数には Snapshot が渡るので、「著者本人なら」のように値と組み合わせた条件も書けます。

actor を when に書くか check に書くかは、次のように分けます。

- **rule を当てるかどうかが、操作した人で変わる。** when に書きます。例えば「管理者以外が公開後に slug を変えたら違反」は、管理者のときには rule 自体が当たりません。
- **操作した人が条件を満たすかどうかが、rule の中身そのもの。** check に書きます。例えば「公開できるのはレビュアーだけ」は、公開という変化のときに当たり、レビュアーでなければ違反にします。

actor の型は、ライブラリでは決めません。アプリケーションが1回だけ登録します。

```ts
declare module "domain-rules" {
  interface Register {
    actor: AppActor;
  }
}

export const isAdmin = (a: AppActor) => a.role === "ADMIN";
```

1つの項目の変化は `changed` で書きます。複数の項目にまたがる条件は、`pre(述語)` と `next(述語)` を `and` などで組み合わせて書きます。

when の正体は `(s: Snapshot) => boolean` という関数です。`changed`、`pre`、`next`、`actor`、`and` などは、この関数を作る関数です。例えば `next(isPublished)` は `(s) => isPublished(s.next)` と同じ判定をします。

`isPublished` のような述語は値を受け取る関数で、Snapshot を受け取る when とは型が違います。そのため `when: isPublished` とは書けず、`next` か `pre` で包むか、`(s) => isPublished(s.next)` と書きます。

作る関数を使う利点は、when が自分の内容を説明できることです。作る関数が返す when には、`{ kind: "changed", field: "status", pre: "DRAFT", next: "PUBLISHED" }` のような説明が付きます。plan はこれを使って「なぜこの rule が当たったか」を表示します。手書きの関数は説明を持たないので、plan では「独自の条件」とだけ表示します。必要なら `describe("公開済みの記事", (s) => ...)` で説明を付けられます。

よく使う形の rule は、rule を返す関数として用意します。

```ts
import { immutable } from "domain-rules";

// 作成後に変えられない項目
export const articleImmutableFields = immutable<Article>(["blogId", "authorId"]);
```

### ruleSet にまとめて公開する(ドメインのパッケージ)

操作ごとに、model と守るべき rule をまとめて公開します。ruleSet は、中の rule が必要とする relation の一覧を型として持ちます。

```ts
import { saveRuleSet } from "domain-rules";

export const saveArticleRules = saveRuleSet(article, [
  statusChangesAreAllowed,
  articleImmutableFields,
  authorIsNotReviewer,
  uniqueSlugInBlog,
  publishAtInFuture,
  onlyReviewerPublishes,
  slugLockedAfterPublish,
  publishedIsApproved,
]);
// RuleSet<typeof article, typeof article.pre | typeof articlesInBlog>
```

ruleSet は普通の値なので、操作ごとに別の組を作ったり、複数の ruleSet で同じ rule を使い回したりできます。

ドメインのパッケージは、操作の名前を付けて ruleSet をまとめて公開します。この名前が、そのまま checker の名前になります。

```ts
export const articleOperations = {
  saveArticle: saveArticleRules,
  archiveArticle: archiveArticleRules,
};
```

### 操作の種類を選ぶ(ドメインのパッケージ)

ruleSet には3種類あり、それぞれ別の関数で作ります。`ruleSet` という1つの関数で種類を切り替えることはしません。種類ごとに受け取るオプションが違い(`fields` と `mode` は保存だけ、`decide` は判定だけで必須)、関数を分けると、間違ったオプションを渡したときの型エラーが「この関数にはこのオプションがない」と素直に出るからです。rule も同じく、種類ごとに別の関数で作ります。

relation、provider、`bind` の仕組みは3種類で共通です。違うのは Snapshot の形と、checker が返すものだけです。

| 種類 | ruleSet の作り方 | rule の作り方 | Snapshot | checker が返すもの |
|---|---|---|---|---|
| 保存 | `saveRuleSet(model, rules, options?)` | `saveRule` | `{ pre: S \| null, next, actor, now }` | `Persistable<S>` |
| 削除 | `deleteRuleSet(model, rules, options?)` | `deleteRule` | `{ pre: S, next: null, actor, now }` | `Deletable<S>` |
| 判定 | `decideRuleSet(action, rules, { decide })` | `decideRule` | `{ input, actor, now }` | `Decision<T>` |

#### 保存する項目を操作ごとに絞る

保存の ruleSet は、既定では schema のすべての項目を入力として受け取り、新規作成と更新の両方を受け付けます。操作ごとに、受け取る項目と、新規作成か更新かを絞れます。

```ts
// 公開の操作。status と publishAt だけを受け取り、既存の記事の更新だけを受け付ける
export const publishArticleRules = saveRuleSet(article, [statusChangesAreAllowed, onlyReviewerPublishes], {
  fields: ["status", "publishAt"],
  mode: "update",
});
// Command の型は { id: string; input: Partial<Pick<..., "status" | "publishAt">>; actor }
```

`mode` は `"create"`、`"update"`、`"upsert"`(既定)のどれかです。`"update"` では `id` が必須になり、`"create"` では `id` を受け取りません。

#### 削除する

削除の ruleSet は、`id` だけを受け取ります。pre を取得し、見つからなければ `notFound` を返します。next は常に `null` です。

```ts
import { deleteRuleSet, deleteRule, pre, not } from "domain-rules";

export const draftOnlyDeletable = deleteRule<Article>({
  name: "削除できるのは下書きだけ",
  when: not(pre(isDraft)),
  check: () => Result.fail("NOT_DRAFT"),
});

export const deleteArticleRules = deleteRuleSet(article, [draftOnlyDeletable]);
// Command は { id: string; actor }。checker は Deletable<Article> を返す
```

```ts
type Deletable<S extends { id: unknown }> = {
  pre: S; // 削除する対象。存在したことが確かめられている
  readonly [proof]: true;
};
```

`deleteRule` で作る rule は、next が `null` の Snapshot を受け取ります。`changed` と `next` は使えず、使うと型エラーになります。保存用の rule を削除の ruleSet に入れることも、型エラーになります。

#### 判定する

何も保存せず、「この操作をしてよいか」と「そのとき何が分かったか」だけを返す操作もあります。プレビューの閲覧、ファイルのダウンロード、外部の装置への指示などです。この種類は model ではなく action を対象にします。

```ts
import { action, relation, decideRule, decideRuleSet, always } from "domain-rules";

export const previewArticle = action({
  name: "previewArticle",
  input: v.object({ articleId: ArticleIdSchema }),
});

// 入力の articleId から決まる記事
export const targetArticle = relation<ActionInput<typeof previewArticle>, Article>("targetArticle");

export const notArchived = decideRule<typeof previewArticle>({
  name: "アーカイブ済みの記事はプレビューできない",
  requires: { targetArticle },
  when: always,
  check: (_s, { targetArticle }) =>
    targetArticle.status !== "ARCHIVED" ? Result.succeed() : Result.fail("ARCHIVED"),
});

export const previewArticleRules = decideRuleSet(previewArticle, [notArchived], {
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
// checker は Decision<{ article: Article; viewerRole: "author" | "reviewer" }> を返す
```

```ts
type Decision<T> = {
  value: T; // decide が返したものだけ。取得した relation のうち、返さなかったものは含まない
  actor: Actor;
  readonly [proof]: true;
};
```

`decide` は、すべての rule を通ったあとに1回だけ呼ばれます。rule は合否だけを返し、値を決めるのは `decide` だけです。`decide` が失敗を返したら、rule の違反と同じく `violations` になります。

`decide` が返したものだけが `Decision` に入ります。usecase は、判定に使った関連データを取り直さずに、`decision.value.article` を使えます。

### 検証のあとに型を強くする(ドメインのパッケージ)

rule を通ったことで分かった事実を、返り値の型に反映できます。証明は checker からしか作れないので、型を強くしても嘘になりません。

#### actor の型を絞る

ruleSet の `actor` に型ガードを渡すと、ほかの段階より先に actor を確かめます。満たさなければ `forbidden` を返し、何も取得しません。

```ts
const isMember = (a: AppActor): a is MemberActor => a.role === "MEMBER" || a.role === "ADMIN";

export const saveArticleRules = saveRuleSet(article, [...], { actor: isMember });
```

この ruleSet の中では、Snapshot の `actor` は `MemberActor` 型になります。rule は、自分が必要とする actor の型を `saveRule<Article, MemberActor>` のように宣言できます。`MemberActor` を必要とする rule を、`actor` で絞っていない ruleSet に入れると型エラーになります。provider に渡る Snapshot の `actor` も同じ型に絞られるので、provider は `actor.organizationId` のような、絞った型にだけある項目を使えます。

#### 項目の値が確かめられたことを型に残す

rule の `refines` に書いた項目は、rule を通ったあと、返り値の型で brand 付きの型になります。値そのものは変わりません。

```ts
import { brand, exists } from "domain-rules";

// 前の例の uniqueSlugInBlog に refines を足したもの。when は always にする
export const uniqueSlugInBlog = saveRule<Article>({
  name: "slug はブログ内で一意",
  requires: { articlesInBlog },
  when: always,
  check: (s, { articlesInBlog }) =>
    articlesInBlog.some((a) => a.slug === s.next.slug && a.id !== s.pre?.id)
      ? Result.fail("DUPLICATED_SLUG")
      : Result.succeed(),
  refines: { slug: brand<"UniqueInBlog">() },
});

// 関連データが存在することを確かめ、その id の項目を Existed<BlogId> にする
export const blogOfArticle = relation<Article, Blog | null>("blogOfArticle");
export const blogExists = exists(blogOfArticle, "blogId");
```

`exists(relation, 項目)` は、「relation が `null` でなければ通り、その項目を `Existed<T>` にする」rule を作る関数です。`Persistable<Article>` の `value.blogId` は `Existed<BlogId>` 型になり、保存する側は存在の確認を繰り返す必要がありません。

`refines` を持つ rule の when は `always` に限ります。`changed("slug")` のように当たらないことがある rule だと、当たらなかったときにも返り値の型が強くなってしまい、型が嘘になるからです。`always` 以外の when と `refines` を一緒に書くと型エラーになります。

型が強くなるのは checker の返り値だけです。同じ ruleSet のほかの rule の Snapshot は強くなりません。rule の判定の順序に依存しないためです。関連データの中身が必要な rule は、型ではなく relation の値そのものを使います。

### provider を定義して束ねる(アプリケーションの組み立て部分)

provider は relation の実装です。ドメインの外で定義します。provider は他の relation を使って取得することもできます。relation 同士の依存は「どう取るか」の都合なので、宣言ではなく provider の側に書きます。

```ts
import { relation, provide, bind } from "domain-rules";
import { article, articlesInBlog, articleOperations } from "@example/domain";

export const articlePreProvider = provide(article.pre, (id) => articleRepository.findById(id));

// 新規作成のときだけ呼ばれる
export const articleIdProvider = provide(article.newId, () => createArticleId());

// provider の中だけで使う relation。ドメインの rule からは見えなくてよい
const blog = relation<Article, Blog>("blog");

export const blogProvider = provide(blog, (s) => blogRepository.findById(s.next.blogId));

export const articlesInBlogProvider = provide(articlesInBlog, {
  requires: { blog },
  load: (_s, { blog }) => articleRepository.findByBlog(blog.id),
});

// すべての ruleSet が必要とする relation と id の生成のうち、provider がないものがあれば型エラーにする
export const operations = bind(
  { ...articleOperations, ...blogOperations },
  {
    providers: [articlePreProvider, articleIdProvider, blogProvider, articlesInBlogProvider],
    clock: () => Date.now(),
  },
);
// {
//   saveArticle: (command: Command<typeof article>) => ResultAsync<Persistable<Article>, CheckError>;
//   archiveArticle: ...;
//   ...
// }
```

`bind` は、名前を付けた ruleSet の一覧と provider の一覧を受け取り、同じ名前の checker の一覧を返します。provider は全部の ruleSet で共有します。ある ruleSet が使わない provider が混ざっていてもかまいません。

束ねるのは起動時に1回だけです。provider の不足は、ここで型エラーとして分かります。

`article.newId` は、`article.pre` と同じく model が自動で持つ宣言で、「新しい id を1つ作る」という意味です。id の生成は乱数や時刻に依存する副作用なので、ほかの取得と同じく provider として注入します。model ごとに id の作り方が違っても、provider を並べるだけで済みます。時計は全部の checker で共通なので、provider とは別に1つだけ渡します。

テストでは、固定の値を返す provider と時計で束ねるだけで済みます。repository の mock はいりません。

```ts
const testOperations = bind(articleOperations, {
  providers: [
    provide.value(article.pre, existingArticle),
    provide.value(article.newId, "art_1" as ArticleId),
    provide.value(articlesInBlog, []),
  ],
  clock: () => 1_700_000_000_000,
});
```

### 実行する(usecase)

usecase は、注入された checker の一覧から1つを呼ぶだけです。rule も provider も知りません。

```ts
type Command<M> = {
  id?: string;                        // あれば更新、なければ新規作成
  input: Partial<SchemaInput<M>>;     // schema の入力の型から作る。検証前の値
  actor: Actor;
};

const saved = await Result.pipe(
  operations.saveArticle({ id: articleId, input: { status: "PUBLISHED" }, actor }),
  Result.andThen((persistable) => repository.save(persistable)), // save は Persistable しか受け取らない
);
```

保存の checker が返す型は次のとおりです。削除と判定の返り値は「操作の種類を選ぶ」の節にあります。

```ts
type Persistable<S extends { id: unknown }> = {
  pre: S | null; // 新規か更新かの判断や、楽観ロックに使える
  value: S;
  readonly [proof]: true; // proof は公開しない unique symbol
};

type CheckError =
  | { kind: "forbidden" }                             // actor が ruleSet の型ガードを満たさない
  | { kind: "invalid"; issues: SchemaIssue[] }       // id か値が schema を満たさない
  | { kind: "notFound" }                              // id を指定したのに pre がない
  | { kind: "violations"; violations: RuleViolation[] }
  | { kind: "loadFailed"; relation: string; cause: unknown };
```

## 実行モデル

checker は呼ばれるたびに、次の6段階で進みます。

0. **actor の確認。** ruleSet に `actor` の型ガードがあれば確かめ、満たさなければ `forbidden` を返します。
1. **resolve。** `id` があれば id の schema で検証し、`article.pre` の provider で既存の値を取ります。見つからなければ `notFound` を返します。`id` がなければ pre は `null` です。
2. **merge。** pre の値に入力を重ねます。入力で `undefined` の項目は pre の値を残し、`null` の項目は `null` で上書きします。
3. **parse。** マージした値を schema で検証し、`next` を作ります。検証には byethrow の `Result.parse` を使い、失敗したら Standard Schema の issue(項目のパス付き)を `invalid` として返します。
4. **plan。** `when` で適用する rule を選び、それらの `requires` と、対応する provider の `requires` をたどって必要な relation を集めます。この段階は純関数です。
5. **load と check。** plan で集めた relation だけを、互いに依存しないものは並列に取得します。そのあと、適用するすべての rule を判定します。最初の違反で止めず、`Result.collect` で違反をすべて集めて返します。
6. **seal。** 違反がなければ、操作の種類に応じた返り値を作って封をします。保存なら id を付けて(更新なら `pre.id`、新規なら `article.newId` の provider で作った id)`Persistable<S>` を、削除なら `Deletable<S>` を作ります。判定なら `decide` を呼んで `Decision<T>` を作ります。

削除では merge と parse を行いません。判定では resolve と merge を行わず、parse は action の入力の schema に対して行います。

`plan` は単体でも呼べるので、「どの rule が当たり、何が必要か」をテストやデバッグで確かめられます。ruleSet に対して呼ぶと、provider を使わずにドメインの範囲だけで分かることを返します。checker に対して呼ぶと、provider の依存までたどった結果を返します。

```ts
plan(saveArticleRules, snapshot);
// { rules: ["著者とレビュアーは別の人", "公開できるのはレビュアーだけ", ...], relations: [] }
```

## データ取得の方針

- **重複除去。** 同じ relation を複数の rule が必要とするときは、1回だけ取得します。同一性の基準は relation の宣言オブジェクトそのものです。
- **batch。** 同じ種類で引数だけ違う取得をまとめる機能は、将来の課題です。
- **リクエストをまたぐキャッシュ。** 行いません。rule は最新のデータで判定する前提なので、古い値で判定が通ると不正なデータが保存されます。

## 設計原則

- **小さな単位で定義する。** model も relation も rule も、1つずつ独立した値です。全体をまとめる設定オブジェクトは作りません。
- **値の検証規則はドメインが持つ。** schema は model の一部としてドメインのパッケージに置きます。checker の外で検証を済ませる必要はありません。
- **マージの規則は1つにする。** `undefined` は「変えない」、`null` は「空にする」です。項目ごとにマージを書く必要はありません。
- **relation は宣言と実装を分ける。** rule は「何が必要か」だけに依存し、「どう取るか」は provider として外から注入します。既存の値(pre)の取得も、同じ仕組みで注入します。
- **`requires` は静的に宣言する。** 依存を実行前に知ることができるので、plan による最適化と説明ができます。
- **ライブラリは状態を知らない。** rule が見るのは pre と next の値の変化だけです。どの値が状態にあたるかは、ドメインが述語として書きます。
- **`when` は Snapshot だけを見る同期の純関数にする。** 関連データを見ないと決まらない条件は、`check` の中で「当てはまらなければ ok」として書きます。
- **`check` は同期の純関数にする。** 副作用は provider と時計にだけ置きます。rule のテストはデータを渡すだけで済みます。
- **証明は checker からしか作れない。** `Persistable<S>`、`Deletable<S>`、`Decision<T>` は、外に公開しない `unique symbol` による brand 型です。
- **rule は合否だけを返す。** 判定の操作で値を決めるのは `decide` だけです。rule が値を返すと、どの rule の値を使うかが判定の順序に依存してしまうからです。
- **id は rule の判定に使わない。** id を付けるのは判定のあとです。rule が自分自身を除外したいときは `pre?.id` を使います。

## スコープ外

- **永続化。** `Persistable<S>` を受け取って保存するのは利用する側の責務です。
- **並行実行での整合性(TOCTOU)。** 一意性などは DB の制約と併用してください。
- **通信の形からコマンドへの変換。** GraphQL や HTTP の型を `Command` に詰め替えるのは、利用する側の責務です。値の検証は checker が行います。
- **時間経過による自動遷移やワークフローの実行。**

## 先行事例

- **Haxl**(Facebook)。ルールが使うデータの取得を自動で重複除去・batch・並列化する Haskell ライブラリです。論文は "There is no Fork"(ICFP 2014)。
- **Build Systems à la Carte**(ICFP 2018)。依存を静的に宣言するタスク(Applicative)は、実行前に最適化できます。`requires` を静的にする根拠です。
- **Ports and Adapters と Effect の `Context.Tag`**。必要なものを型付きの宣言として表し、実装は外から注入する考え方です。relation と provider の関係がこれにあたります。
- **Event-B と Design by Contract**。不変条件と遷移のガードを分けて書く考え方です。
- **Parse, don't validate**(Alexis King)。検証が通ったら、より強い型に変える考え方です。parse の段階と `Persistable<S>` がこれにあたります。
- **Standard Schema**。schema ライブラリに共通のインターフェースです。これに対応することで、特定の schema ライブラリに依存しません。

## 未決定の論点

- **provider の網羅を型で保証できるか。** 束ねるすべての ruleSet が必要とする relation と id の生成(provider の requires をたどった先も含む)のすべてに provider があることを、`bind` の型で確かめたい。ruleSet の一覧と provider の配列から推論が成り立つかは、まだ試していません。
- **既存の値の再検証。** 更新のたびに、pre とマージした値の全体を schema で検証します。schema を厳しくしたあと、古いデータを持つ記事は、関係ない項目を更新するときにも失敗します。これを正しい振る舞いとするか、変更した項目だけを検証する方法を用意するかは決めていません。
- **入れ子の値のマージ。** 今の規則は1段目の項目だけを重ねます。入れ子のオブジェクトを部分的に更新したい場合の扱いは決めていません。
- **relation に引数を持たせるか。** 今は `Snapshot` から決まる値だけを扱います(`article.pre` は id を引数にとる例外)。「next の blog」と「pre の blog」のように対象が違うものは、別の relation として宣言します。
- **actor の型の登録方法。** 今は `Register` への型の登録(module augmentation)で、アプリケーション全体で1つの actor の型を使う想定です。境界付けられたコンテキストごとに actor の型が違う場合は、`ruleFor<Article, Actor>()` のように型を束ねた rule の作り方が必要になります。
- **保存の操作で値を決める。** 今の `decide` は判定の操作だけで使えます。保存の操作でも「保存した値と一緒に、決めた値を返す」必要が出たら、保存の ruleSet にも `decide` を足します。
- **`refines` の型の計算。** 複数の rule の `refines` を合わせて返り値の型を作る計算(union から intersection への変換)が、rule の数が増えても実用的な速さで終わるかは試していません。
- **`when` が関連データを必要とするケース。** これがどのくらい出てくるかによって、二段階の plan を入れるかを決めます。

## License

未定
