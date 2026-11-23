# domain-rules

ドメインルールを小さな単位で定義し、必要なデータだけを取得して検証し、検証済みであることを型で証明する TypeScript ライブラリです。

> **Status**: 設計段階です。この README の API は構想であり、まだ実装していません。

## なぜ作るのか

エンティティを保存する前の検証を手で書くと、次の問題が起きます。

- **ルールの適用条件が `if` の中に埋もれる。** 「新規作成のときだけ」「下書きから公開に変わるときだけ」といった条件が、本体のコードを読まないと分かりません。
- **取得の工程を手で書く必要がある。** どのルールが何を使うかを意識しながら取得処理を書き、順序や重複を自分で管理することになります。
- **ルールが副作用を持つ。** ルールの中で repository を呼ぶと、テストに mock が必要になります。
- **「検証済み」が保証されない。** 検証を通さずに保存用のオブジェクトを組み立てても、型では防げません。

## 中心となるモデル

部品は `relation` と `rule` の2つだけです。どちらも1つずつ独立して定義し、配列にして組み合わせます。

```
relation = load(取得方法) + requires(他の relation への依存)
rule     = requires(使う relation) + when(適用する条件) + check(判定)
checked  = pre(変更前) + next(変更後) + 「適用されたすべての rule を通った」証明
```

- `pre` は変更前の状態です。新規作成のときは `null` になります。
- `next` は変更後の状態です。入力を `pre` にマージしたものです。
- rule は `(pre, next, actor)` についての条件です。「常に」「特定の状態のとき」「特定の遷移のとき」は、`when` が違うだけです。

| 種類 | when |
|---|---|
| 不変条件 | `always` |
| 状態ごとの条件 | `inState("PUBLISHED")` |
| 遷移のガード | `transition("DRAFT", "PUBLISHED")` |
| 作成時の条件 | `onCreate` |
| 変更時の条件 | `changed("publishAt")` |

## 使用例(構想)

ブログ記事を題材にします。

```ts
type Article = {
  id: ArticleId;
  blogId: BlogId;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  authorId: UserId;
  reviewerId: UserId;
  slug: string;
  publishAt: number;
};
```

### relation を定義する

relation は1つの関連データです。取得に必要な port は、relation ごとに型で宣言します。

```ts
import { relation } from "domain-rules";

export const blog = relation(
  (s: Snapshot<Article>, ports: { findBlog: FindBlog }) => ports.findBlog(s.next.blogId),
);

export const articlesInBlog = relation({
  requires: { blog },
  load: (_s: Snapshot<Article>, { blog }, ports: { findArticlesByBlog: FindArticlesByBlog }) =>
    ports.findArticlesByBlog(blog.id),
});
```

### rule を定義する

rule は1つのルールです。`requires` には relation そのものを渡します。文字列の名前を使わないので、`check` の引数の型は自動で決まり、宣言していない relation は使えません。

```ts
import { rule, always, changed, transition } from "domain-rules";
import { ok, err } from "neverthrow";

export const authorIsNotReviewer = rule<Article>({
  name: "著者とレビュアーは別の人",
  when: always,
  check: (s) => (s.next.authorId !== s.next.reviewerId ? ok() : err("SAME_AUTHOR_AND_REVIEWER")),
});

export const uniqueSlugInBlog = rule<Article>({
  name: "slug はブログ内で一意",
  requires: { articlesInBlog },
  when: changed("slug"),
  check: (s, { articlesInBlog }) =>
    articlesInBlog.some((a) => a.slug === s.next.slug && a.id !== s.pre?.id)
      ? err("DUPLICATED_SLUG")
      : ok(),
});

export const onlyReviewerPublishes = rule<Article>({
  name: "公開できるのはレビュアーだけ",
  when: transition("DRAFT", "PUBLISHED"),
  check: (s) => (s.actor.id === s.next.reviewerId ? ok() : err("NOT_REVIEWER")),
});
```

状態遷移の許可リストも、ただの rule です。

```ts
import { allowedTransitions } from "domain-rules";

// ここにない遷移はすべて違反にする rule を作る
export const articleStatusTransitions = allowedTransitions<Article>("status", {
  initial: ["DRAFT"],
  DRAFT: ["DRAFT", "PUBLISHED"],
  PUBLISHED: ["PUBLISHED", "ARCHIVED"],
  ARCHIVED: ["ARCHIVED"],
});
```

### 組み合わせて実行する

```ts
import { run } from "domain-rules";

const articleRules = [
  articleStatusTransitions,
  authorIsNotReviewer,
  uniqueSlugInBlog,
  onlyReviewerPublishes,
];

const result = await run(articleRules, { pre, next, actor }, ports);
// ports の型は、使われる relation が宣言した port の合成として推論される
// ResultAsync<Checked<Article>, RuleViolation[] | LoadError>

result.map((checked) => repository.save(checked)); // save は Checked しか受け取らない
```

rule は普通の値なので、操作ごとに別の配列を組んだり、複数のエンティティで同じ rule を使い回したりできます。

## 実行モデル

`run` は次の4段階で進みます。

1. **plan**:`when` で適用する rule を選び、それらの `requires` をたどって必要な relation を集めます。この段階は純関数です。
2. **load**:plan で集めた relation だけを取得します。互いに依存しないものは並列に取得します。
3. **check**:適用するすべての rule を判定します。最初の違反で止めず、違反をすべて集めて返します。
4. **seal**:違反がなければ `Checked<S>` として封をします。

`plan` は単体でも呼べるので、「どの rule が当たり、何を取得するか」をテストやデバッグで確かめられます。

```ts
plan(articleRules, { pre, next, actor });
// { rules: ["著者とレビュアーは別の人", "公開できるのはレビュアーだけ", ...], relations: [] }
```

## データ取得の方針

- **重複除去**:同じ relation を複数の rule が必要とするときは、1回だけ取得します。同一性の基準は relation オブジェクトそのものです。
- **batch**:同じ種類で引数だけ違う取得をまとめる機能は、将来の課題です。
- **リクエストをまたぐキャッシュ**:行いません。rule は最新のデータで判定する前提なので、古い値で判定が通ると不正なデータが保存されます。

## 設計原則

- **小さな単位で定義する。** relation も rule も1つずつ独立した値です。全体をまとめる設定オブジェクトは作りません。
- **`requires` は静的に宣言する。** 依存を実行前に知ることができるので、plan による最適化と説明ができます。
- **`when` は `(pre, next, actor)` だけを見る同期の純関数にする。** 関連データを見ないと決まらない条件は、`check` の中で「当てはまらなければ ok」として書きます。
- **`check` は同期の純関数にする。** 副作用は relation の `load` にだけ置きます。rule のテストはデータを渡すだけで済みます。
- **証明は `run` からしか作れない。** `Checked<S>` は外に公開しない `unique symbol` による brand 型です。

## スコープ外

- **永続化と ID の発行。** `Checked<S>` を受け取って保存するのは利用する側の責務です。
- **並行実行での整合性(TOCTOU)。** 一意性などは DB の制約と併用してください。
- **入力のスキーマ検証。** `next` を作る前の検証には Zod などを使ってください。
- **時間経過による自動遷移やワークフローの実行。**

## 先行事例

- **Haxl**(Facebook):ルールが使うデータの取得を自動で重複除去・batch・並列化する Haskell ライブラリ。"There is no Fork"(ICFP 2014)。
- **Build Systems à la Carte**(ICFP 2018):依存を静的に宣言するタスク(Applicative)は、実行前に最適化できる。`requires` を静的にする根拠です。
- **Event-B / Design by Contract**:不変条件と遷移のガードを分けて書く考え方。
- **Parse, don't validate**(Alexis King):検証が通ったら、より強い型に変える。`Checked<S>` がこれにあたります。

## 未決定の論点

- **Result 型。** neverthrow を peer dependency にするか、独自の軽い型にするか。
- **値を決めるルール。** 合否ではなく値を返すもの(割引額の計算など)を、rule の戻り値で扱うか、別の部品にするか。
- **`when` が関連データを必要とするケース。** これがどのくらい出てくるかによって、二段階の plan を入れるかを決めます。
- **保存を伴わない操作。** 削除や、判定だけを行う操作を同じ仕組みでどこまで扱うか。

## License

未定
