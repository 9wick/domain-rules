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
| model | エンティティの形 | id の schema、値の schema、port の宣言(id から取る、新しい id を作る) |
| action | 保存を伴わない操作の入力の形 | 入力の schema |
| rule | 1つの条件 | `requires`、`when`、`check`、`refines` |
| relation | 判定に必要なデータの宣言 | 名前、どの Snapshot から決まるか、型 |
| entityRules | model のルールの組 | 受け付ける actor の型ガード、保存のルール、削除のルール |
| actionRules | action のルールの組 | 受け付ける actor の型ガード、判定のルール、`decide` |
| provider | 宣言された port の実装 | relation、model の port、時計のどれか1つの実装 |
| bind | ルールの組と provider を束ねる | なし |

成功と失敗は [@praha/byethrow](https://github.com/praha-inc/byethrow) の `Result` で表します。rule の `check` は `Result`、provider と、束ねたあとに呼ぶ関数は `ResultAsync`(`Promise<Result>`)を返します。schema には Valibot など、[Standard Schema](https://standardschema.dev) を実装したライブラリを使えます。

### 定義する場所

| 段階 | 場所 | やること |
|---|---|---|
| 組む | ドメインのパッケージ | model、action、relation、rule を定義し、対象ごとにルールの組を作って公開する |
| 束ねる | アプリケーションの組み立て部分(DI の設定) | ルールの組の一覧に provider を渡す |
| 実行する | usecase | 束ねた結果の、対象ごとのメソッドを呼ぶ |

ドメインのパッケージは repository や DB を一切知りません。副作用はすべて port として宣言され、provider として外から注入されます。

## 使用例(構想)

ブログ記事を題材にします。

### model を定義する

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

export type ArticleValue = Value<typeof article>;   // schema の出力の型。id を持たない
export type Article = Entity<typeof article>;       // { id: ArticleId } と ArticleValue を合わせたもの
```

model は2つの port を自動で宣言します。`article.load` は「id から既存の記事を取る」、`article.newId` は「新しい id を1つ作る」です。どちらも実装は provider として後から注入します。

作成時の既定値は schema に書きます。新規作成のときは既存の値がないので、入力にない項目には schema の既定値が入ります。更新のときは既存の値が入るので、既定値は使われません。

### Snapshot の種類を知る

rule と relation は、Snapshot を受け取ります。Snapshot は、何に対する判定かによって3種類あります。

```ts
type SaveSnapshot<M> = {
  pre: Entity<M> | null;   // 変更前。新規作成のときは null
  next: Value<M>;          // 変更後。入力を pre にマージし、schema で検証したもの
  actor: Actor;
  now: number;             // 呼び出された時刻。1回の実行の中では同じ値
};

type DeleteSnapshot<M> = {
  pre: Entity<M>;          // 削除する対象
  next: null;
  actor: Actor;
  now: number;
};

type ActionSnapshot<A> = {
  input: ActionInput<A>;   // 入力の schema で検証したもの
  actor: Actor;
  now: number;
};
```

ドメインのパッケージでは、よく使う Snapshot に別名を付けておくと読みやすくなります。

```ts
export type ArticleSave = SaveSnapshot<typeof article>;
export type ArticleDelete = DeleteSnapshot<typeof article>;
```

ライブラリは「状態」という概念を持ちません。どの項目が状態なのかを、ライブラリは知りません。「下書き」「承認済み」のような判断は、値についての述語としてドメインの側に書きます。述語はただの関数で、ライブラリに登録する必要はありません。

```ts
export const isDraft = (a: ArticleValue) => a.status === "DRAFT";
export const isPublished = (a: ArticleValue) => a.status === "PUBLISHED";
export const isApproved = (a: ArticleValue) => a.approvedAt !== null;
```

### relation を宣言する

relation は「この判定には、こういうデータが必要だ」という宣言です。どの Snapshot から決まるかと、型だけを持ち、取得方法は持ちません。

```ts
import { relation } from "domain-rules";

// 保存の Snapshot から決まる、同じブログ内の記事一覧
export const articlesInBlog = relation<ArticleSave, readonly Article[]>("articlesInBlog");
```

relation の Snapshot の種類と、それを使う rule の Snapshot の種類が違うと型エラーになります。保存の Snapshot から決まる relation は、`next` が `null` の削除の判定では使えないからです。

### rule を定義する

rule は1つの条件です。型引数に、どの Snapshot に対する条件かを書きます。`requires` には relation そのものを渡します。文字列の名前を使わないので、`check` の引数の型は自動で決まり、宣言していない relation は使えません。

```ts
import { rule, always, changed, next, pre, actor, and, not } from "domain-rules";
import { Result } from "@praha/byethrow";

export const authorIsNotReviewer = rule<ArticleSave>({
  name: "著者とレビュアーは別の人",
  when: always,
  check: (s) =>
    s.next.authorId !== s.next.reviewerId
      ? Result.succeed()
      : Result.fail("SAME_AUTHOR_AND_REVIEWER"),
});

export const uniqueSlugInBlog = rule<ArticleSave>({
  name: "slug はブログ内で一意",
  requires: { articlesInBlog },
  when: changed("slug"),
  check: (s, { articlesInBlog }) =>
    articlesInBlog.some((a) => a.slug === s.next.slug && a.id !== s.pre?.id)
      ? Result.fail("DUPLICATED_SLUG")
      : Result.succeed(),
});

export const publishAtInFuture = rule<ArticleSave>({
  name: "公開日時は未来",
  when: changed("publishAt"),
  check: (s) =>
    s.next.publishAt > s.now ? Result.succeed() : Result.fail("PUBLISH_AT_IN_PAST"),
});

export const onlyReviewerPublishes = rule<ArticleSave>({
  name: "公開できるのはレビュアーだけ",
  when: changed("status", { pre: "DRAFT", next: "PUBLISHED" }),
  check: (s) =>
    s.actor.id === s.next.reviewerId ? Result.succeed() : Result.fail("NOT_REVIEWER"),
});

export const slugLockedAfterPublish = rule<ArticleSave>({
  name: "公開後の slug を変えられるのは管理者だけ",
  when: and(changed("slug"), pre(isPublished), not(actor(isAdmin))),
  check: () => Result.fail("SLUG_LOCKED"),
});

export const publishedIsApproved = rule<ArticleSave>({
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

export const statusChangesAreAllowed = rule<ArticleSave>({
  name: "status は許可された変化だけ",
  when: changed("status"),
  check: (s) => {
    const allowed = s.pre === null ? ["DRAFT"] : allowedStatusChanges[s.pre.status];
    return allowed.includes(s.next.status)
      ? Result.succeed()
      : Result.fail("STATUS_CHANGE_NOT_ALLOWED");
  },
});

export const onlyDraftIsDeletable = rule<ArticleDelete>({
  name: "削除できるのは下書きだけ",
  when: not(pre(isDraft)),
  check: () => Result.fail("NOT_DRAFT"),
});
```

よく使う形の rule は、rule を返す関数として用意します。

```ts
import { immutable } from "domain-rules";

// 作成後に変えられない項目
export const articleImmutableFields = immutable<ArticleSave>(["blogId", "authorId"]);
```

### when を書く

`when` の種類は次のとおりです。

| 種類 | when | 使える Snapshot |
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

使えない Snapshot の rule に書くと、型エラーになります。

`changed` の `pre` と `next` には、その項目の値か、その項目の値を受け取る述語を渡します。どちらも、値が変わったときだけ当たります。1つの項目の変化は `changed` で書き、複数の項目にまたがる条件は `pre(述語)` と `next(述語)` を `and` などで組み合わせて書きます。

actor を when に書くか check に書くかは、次のように分けます。

- **rule を当てるかどうかが、操作した人で変わる。** when に書きます。例えば「管理者以外が公開後に slug を変えたら違反」は、管理者のときには rule 自体が当たりません。
- **操作した人が条件を満たすかどうかが、rule の中身そのもの。** check に書きます。例えば「公開できるのはレビュアーだけ」は、公開という変化のときに当たり、レビュアーでなければ違反にします。

when の正体は `(s: Snapshot) => boolean` という関数で、`changed` や `next` などはこの関数を作る関数です。作る関数が返す when には、`{ kind: "changed", field: "status", pre: "DRAFT", next: "PUBLISHED" }` のような説明が付きます。plan はこれを使って「なぜこの rule が当たったか」を表示します。手書きの関数には、`describe("公開済みの記事", (s) => ...)` で説明を付けられます。

### model のルールの組を作る

model ごとに、ルールの組を1つ作ります。保存のルールと削除のルールを、それぞれ並べます。

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
    slugLockedAfterPublish,
    publishedIsApproved,
  ],
  delete: [onlyDraftIsDeletable],
});
```

- **`save`。** 保存の Snapshot に対する rule を並べます。`create`、`update`、`upsert` のどれで呼ばれても、この一覧から `when` が当たるものを判定します。
- **`delete`。** 削除の Snapshot に対する rule を並べます。`delete` を書かなければ、その model は削除できません。束ねたあとに `delete` のメソッドが作られないからです。`save` も同じです。
- **`actor`。** この model を操作できる actor の型ガードです。省略すると、どの actor でも受け付けます。

`actor` の型ガードは、id や入力の検証と同じく、Command を受け取る境界での検証です。満たさなければ、何も取得せずに `forbidden` を返します。通った actor は、ルールの組の中のすべての rule と provider で、型ガードの型(この例では `MemberActor`)として扱われます。rule が絞った型の actor を必要とするときは、`rule<SaveSnapshot<typeof article, MemberActor>>` のように Snapshot の型引数で宣言します。その rule を、actor を `MemberActor` に絞らないルールの組に入れると型エラーになります。

actor の型そのものは、アプリケーションが1回だけ登録します。

```ts
declare module "domain-rules" {
  interface Register {
    actor: AppActor;
  }
}
```

1つの model に、ルールの組は1つだけです。同じ model のルールの組を2つ束ねようとすると、`bind` が型エラーにします。

### action のルールの組を作る

何も保存せず、「この操作をしてよいか」と「そのとき何が分かったか」だけを返す操作は、action として定義します。プレビューの閲覧、ファイルのダウンロード、外部の装置への指示などです。

```ts
import { action, actionRules, relation, rule, always, type ActionSnapshot } from "domain-rules";

export const previewArticle = action({
  name: "previewArticle",
  input: v.object({ articleId: ArticleIdSchema }),
});

type PreviewArticle = ActionSnapshot<typeof previewArticle>;

// 入力の articleId から決まる記事
export const targetArticle = relation<PreviewArticle, Article>("targetArticle");

export const notArchived = rule<PreviewArticle>({
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

`decide` は、すべての rule を通ったあとに1回だけ呼ばれ、返す値を決めます。rule は合否だけを返し、値を決めるのは `decide` だけです。`decide` が失敗を返したら、rule の違反と同じく `violations` になります。返り値の `Decision` には、`decide` が返したものだけが入ります。

### 確かめた値を型に残す

rule の `refines` に書いた項目は、rule を通ったあと、返り値の型で brand 付きの型になります。値そのものは変わりません。

```ts
import { brand, exists } from "domain-rules";

// 前の例の uniqueSlugInBlog に refines を足したもの。when は always にする
export const uniqueSlugInBlog = rule<ArticleSave>({
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
export const blogOfArticle = relation<ArticleSave, Blog | null>("blogOfArticle");
export const blogExists = exists(blogOfArticle, "blogId");
```

- **when は `always` に限る。** 当たらないことがある rule だと、当たらなかったときにも型が強くなってしまい、型が嘘になるからです。`always` 以外の when と `refines` を一緒に書くと型エラーになります。
- **強くなるのは返り値の型だけ。** 同じルールの組のほかの rule が見る Snapshot は強くなりません。rule の判定は互いに順序を持たないので、ほかの rule の結果を前提にできないからです。

actor の型の絞り込みは、ここではなく、ルールの組の `actor` で行います。actor の型ガードは境界での検証で、rule の結果ではないからです。

### provider を定義して束ねる

provider は、宣言された port の実装です。relation、model の port(`load` と `newId`)、時計のどれでも、同じ `provide` で渡します。ドメインの外で定義します。

```ts
import { relation, provide, bind, clock } from "domain-rules";
import { article, articlesInBlog, articleRules, previewArticleRules, targetArticle } from "@example/domain";

// provider の中だけで使う relation。ドメインの rule からは見えなくてよい
const blog = relation<ArticleSave, Blog>("blog");

export const providers = [
  provide(article.load, (id) => articleRepository.findById(id)),
  provide(article.newId, () => createArticleId()),
  provide(articlesInBlog, {
    requires: { blog },
    load: (_s, { blog }) => articleRepository.findByBlog(blog.id),
  }),
  provide(blog, (s) => blogRepository.findById(s.next.blogId)),
  provide(targetArticle, (s) => articleRepository.findById(s.input.articleId)),
  provide(clock, () => Date.now()),
];

export const domain = bind([articleRules, previewArticleRules], { providers });
// {
//   article: { create, update, upsert, delete },
//   previewArticle: { decide },
// }
```

provider は他の relation を使って取得することもできます。relation 同士の依存は「どう取るか」の都合なので、宣言ではなく provider の側に書きます。

`bind` は起動時に1回だけ呼びます。ルールの組が必要とする port のうち、provider がないものがあれば型エラーにします。ある組が使わない provider が混ざっていてもかまいません。

テストでは、固定の値を返す provider で束ねるだけで済みます。repository の mock はいりません。

```ts
const testDomain = bind([articleRules], {
  providers: [
    provide.value(article.load, existingArticle),
    provide.value(article.newId, "art_1" as ArticleId),
    provide.value(articlesInBlog, []),
    provide.value(clock, 1_700_000_000_000),
  ],
});
```

### 実行する(usecase)

usecase は、束ねた結果の、対象ごとのメソッドを呼ぶだけです。rule も provider も知りません。

```ts
const saved = await Result.pipe(
  domain.article.update({ id: articleId, input: { status: "PUBLISHED" }, actor }),
  Result.andThen((persistable) => repository.save(persistable)), // save は Persistable しか受け取らない
);
```

| メソッド | 受け取るもの | 返すもの |
|---|---|---|
| `create` | `{ input, actor }` | `Persistable<S>`(`pre` は `null`) |
| `update` | `{ id, input, actor }` | `Persistable<S>`(`pre` は必ずある) |
| `upsert` | `{ id?, input, actor }` | `Persistable<S>` |
| `delete` | `{ id, actor }` | `Deletable<S>` |
| `decide` | `{ input, actor }` | `Decision<T>` |

`input` は、schema の入力の型を `Partial` にしたものです。

```ts
type Persistable<S> = {
  pre: S | null;             // 新規か更新かの判断や、楽観ロックに使える
  value: S;                  // refines で強くなった型を含む
  readonly [proof]: true;    // proof は公開しない unique symbol
};

type Deletable<S> = {
  pre: S;                    // 削除する対象。存在したことが確かめられている
  readonly [proof]: true;
};

type Decision<T> = {
  value: T;                  // decide が返したもの
  actor: Actor;              // ルールの組の actor の型ガードで絞った型
  readonly [proof]: true;
};

type CheckError =
  | { kind: "forbidden" }                             // actor が型ガードを満たさない
  | { kind: "invalid"; issues: SchemaIssue[] }        // id、入力、マージした値が schema を満たさない
  | { kind: "notFound" }                              // 指定した id の既存の値がない
  | { kind: "violations"; violations: RuleViolation[] }
  | { kind: "loadFailed"; port: string; cause: unknown };
```

## 実行モデル

束ねたメソッドは、呼ばれるたびに次の段階で進みます。

| 段階 | やること | 責任を持つ部品 | 失敗したとき |
|---|---|---|---|
| 1. 受け取る | id、入力、actor を検証する | model と action の schema、ルールの組の `actor` | `invalid`、`forbidden` |
| 2. resolve | 既存の値を取る | `model.load` の provider | `notFound` |
| 3. merge | 既存の値に入力を重ねる | ライブラリ | なし |
| 4. parse | マージした値を検証して next を作る | model の schema | `invalid` |
| 5. plan | 当たる rule と、必要な relation を決める | ルールの組の rule の `when` と `requires` | なし |
| 6. load と check | relation を取り、rule を判定する | relation の provider、rule の `check` | `loadFailed`、`violations` |
| 7. seal | 返り値を作って封をする | `model.newId` の provider、action の `decide` | `violations` |

- **merge の規則。** 入力で `undefined` の項目は既存の値を残し、`null` の項目は `null` で上書きします。
- **load と check。** 互いに依存しない relation は並列に取得します。rule は最初の違反で止めず、`Result.collect` で違反をすべて集めて返します。
- **seal。** 保存では id を付けます(更新なら既存の id、新規なら `model.newId` の provider で作った id)。

メソッドによって、通らない段階があります。

- **`create`。** resolve を行いません。
- **`delete`。** merge と parse を行いません。
- **`decide`。** resolve と merge を行わず、parse は action の入力の schema に対して行います。

`plan` は単体でも呼べるので、「どの rule が当たり、何が必要か」をテストやデバッグで確かめられます。

```ts
plan(articleRules, snapshot);
// { rules: ["著者とレビュアーは別の人", "公開できるのはレビュアーだけ", ...], relations: [] }
```

## データ取得の方針

- **重複除去。** 同じ relation を複数の rule が必要とするときは、1回だけ取得します。同一性の基準は relation の宣言オブジェクトそのものです。
- **batch。** 同じ種類で引数だけ違う取得をまとめる機能は、将来の課題です。
- **リクエストをまたぐキャッシュ。** 行いません。rule は最新のデータで判定する前提なので、古い値で判定が通ると不正なデータが保存されます。

## 設計原則

- **ルールの組は対象と1対1。** 操作ごとにルールの組を作りません。どのルールが当たるかは `when` が値の変化から決めます。ルールの並べ忘れで、ある操作だけ検査が抜けることはありません。
- **小さな単位で定義する。** model、action、relation、rule は1つずつ独立した値です。
- **境界で受け取り、中では信じる。** id、入力、actor は最初の段階で検証します。通ったあとは、すべての rule と provider がその型を信じます。
- **副作用はすべて port。** relation、既存の値の取得、id の生成、時計は、どれも宣言された port で、どれも `provide` で注入します。
- **値の検証規則はドメインが持つ。** schema は model の一部としてドメインのパッケージに置きます。
- **マージの規則は1つにする。** `undefined` は「変えない」、`null` は「空にする」です。
- **relation と rule は Snapshot の種類を持つ。** 種類の違うものを組み合わせると型エラーになります。
- **`requires` は静的に宣言する。** 依存を実行前に知ることができるので、plan による最適化と説明ができます。
- **ライブラリは状態を知らない。** rule が見るのは pre と next の値の変化だけです。
- **`when` と `check` は同期の純関数にする。** 関連データを見ないと決まらない条件は、`check` の中で「当てはまらなければ ok」として書きます。
- **rule は合否だけを返す。** 値を決めるのは action の `decide` だけです。
- **証明は束ねたメソッドからしか作れない。** `Persistable<S>`、`Deletable<S>`、`Decision<T>` は、外に公開しない `unique symbol` による brand 型です。

## スコープ外

- **永続化。** `Persistable<S>` や `Deletable<S>` を受け取って保存・削除するのは利用する側の責務です。
- **並行実行での整合性(TOCTOU)。** 一意性などは DB の制約と併用してください。
- **API ごとの入力の形。** 「この API からは status しか受け取らない」のような制限は、usecase が受け取る型を狭めて行います。「status を変えられるのはレビュアーだけ」のようなドメインの制限は、rule として書きます。
- **通信の形からの変換。** GraphQL や HTTP の型を、メソッドの引数に詰め替えるのは利用する側の責務です。
- **時間経過による自動遷移やワークフローの実行。**

## 先行事例

- **Haxl**(Facebook)。ルールが使うデータの取得を自動で重複除去・batch・並列化する Haskell ライブラリです。論文は "There is no Fork"(ICFP 2014)。
- **Build Systems à la Carte**(ICFP 2018)。依存を静的に宣言するタスク(Applicative)は、実行前に最適化できます。`requires` を静的にする根拠です。
- **Ports and Adapters と Effect の `Context.Tag`**。必要なものを型付きの宣言として表し、実装は外から注入する考え方です。port と provider の関係がこれにあたります。
- **Event-B と Design by Contract**。不変条件と遷移のガードを分けて書く考え方です。
- **Parse, don't validate**(Alexis King)。検証が通ったら、より強い型に変える考え方です。境界での検証と、`refines` と、返り値の brand 型がこれにあたります。
- **Standard Schema**。schema ライブラリに共通のインターフェースです。これに対応することで、特定の schema ライブラリに依存しません。

## 未決定の論点

- **port の網羅を型で保証できるか。** 束ねるすべてのルールの組が必要とする port(provider の requires をたどった先も含む)のすべてに provider があることを、`bind` の型で確かめたい。推論が成り立つかは、まだ試していません。
- **既存の値の再検証。** 更新のたびに、マージした値の全体を schema で検証します。schema を厳しくしたあと、古いデータを持つ記事は、関係ない項目を更新するときにも失敗します。これを正しい振る舞いとするかは決めていません。
- **入れ子の値のマージ。** 今の規則は1段目の項目だけを重ねます。
- **relation に引数を持たせるか。** 今は Snapshot から決まる値だけを扱います。「next の blog」と「pre の blog」のように対象が違うものは、別の relation として宣言します。
- **actor の型の登録方法。** 今は `Register` への型の登録(module augmentation)で、アプリケーション全体で1つの actor の型を使う想定です。
- **保存で値を決める。** 今の `decide` は action だけが持ちます。保存でも「保存した値と一緒に、決めた値を返す」必要が出たら、model のルールの組にも足します。
- **`refines` の型の計算。** 複数の rule の `refines` を合わせて返り値の型を作る計算が、rule の数が増えても実用的な速さで終わるかは試していません。
- **`when` が関連データを必要とするケース。** これがどのくらい出てくるかによって、二段階の plan を入れるかを決めます。

## License

未定
