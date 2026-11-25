# domain-rules

データの作成・更新・削除やアクション実行前のビジネスルールを小さな単位で定義し、必要なデータだけを取得・検証して、「検証済みであること」を TypeScript の型で保証するライブラリです。

> **Status**: 試作段階です（npm 未公開）。より実践的な定義例は [test/blog/domain.ts](test/blog/domain.ts) にあり、型検査とテストで動作を確認しています。

## 何ができるか

- **ルールを小さな単位で宣言できる**: 「いつ適用するか (`when`)」と「何を検証するか (`check`)」を分けて定義し、モデルごとに 1 本の検証パイプライン (`ruleset`) として組み立てます。
- **検証結果を型に反映できる（型の昇格）**: 前段のルールで確認した値（採番済みの ID や存在確認済みの値など）を状態へマージして型を絞り込み、保存可能な型を満たしているかをコンパイル時に検証します。
- **外部依存を分離してテストしやすい**: DB 参照などの副作用は `port` として宣言し、起動時に `bind` で実装 (`provider`) を注入します。テストでは `provide.value` で固定値を渡すだけで、リポジトリのモックは不要です。
- **未検証データの保存を型で防ぐ**: すべてのルールを通過した値だけが `Persistable` などの検証済みラッパーとして返り、`open()` でのみ中身を取り出せます。

## 前提

- TypeScript
- [Standard Schema](https://github.com/standard-schema/spec) 準拠のスキーマライブラリ（例: Valibot）
- [`@praha/byethrow`](https://github.com/praha-inc/byethrow)（成功・失敗を `Result` / `ResultAsync` で表現）

## クイックスタート

全体の流れは **1. 定義（モデル・ポート・ルール） → 2. 注入（`bind`） → 3. 実行と取り出し（`open`）** です。

```ts
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import {
  always,
  bind,
  changed,
  clock,
  model,
  modelRules,
  open,
  port,
  provide,
  rule,
  ruleset,
  type Persisted,
} from "domain-rules";

// 1. モデル・ポート・ルールを定義する（ドメイン層）
const articleInput = v.object({
  id: v.optional(v.string()),
  title: v.pipe(v.string(), v.minLength(1)),
  status: v.optional(v.picklist(["DRAFT", "PUBLISHED"]), "DRAFT"),
});

const article = model({
  name: "article",
  schema: {
    input: articleInput,
    persisted: v.object({ ...articleInput.entries, id: v.string() }),
  },
});

const findArticleById = port("findArticleById").of<(id: string) => Persisted<typeof article> | null, never>();
const newArticleId = port("newArticleId").of<() => string, never>();

const publishRequiresLongTitle = rule(article.onSave, {
  name: "公開時はタイトルが5文字以上",
  when: changed("status", { next: "PUBLISHED" }),
  check: ({ next }) => (next.title.length >= 5 ? Result.succeed() : Result.fail("TITLE_TOO_SHORT")),
});

const assignArticleId = rule(article.onSave, {
  name: "ID を確定する",
  requires: { newArticleId },
  when: always,
  check: async ({ pre }, { newArticleId }) => {
    if (pre !== null) return Result.succeed({ next: { id: pre.id } });
    const id = await newArticleId();
    return Result.isFailure(id) ? id : Result.succeed({ next: { id: id.value } });
  },
});

const articleRules = modelRules(article)
  .load(findArticleById)
  .save(ruleset(publishRequiresLongTitle).add(assignArticleId));

// 2. provider を注入して呼び出し可能な API を組み立てる（起動時 / DI）
const domain = bind([articleRules], {
  providers: [
    provide(findArticleById, (id) => articleRepo.findById(id)),
    provide(newArticleId, () => Result.succeed(crypto.randomUUID())),
    provide(clock, () => Date.now()),
  ],
});

// 3. 実行し、検証済みの値を取り出して保存する（Usecase）
const result = await domain.article.create({
  input: { title: "Hello domain-rules" },
  actor: { id: "usr_1" },
});

if (Result.isSuccess(result)) {
  const { next } = open(result.value); // next は Persisted<typeof article> 型
  await articleRepo.save(next);
}
```

`modelRules` の定義に応じて、`domain.article` には `create` / `update` / `upsert` / `delete` が生成されます。永続化を伴わない操作は `action` / `actionRules`（`decide`）で定義できます。

## ドキュメント

目的に応じて `docs/` 配下のドキュメントを参照してください。

| 知りたいこと               | ドキュメント                                            | 主な内容                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 使い方と実行時の動作仕様   | [利用ガイド (`docs/guide.md`)](docs/guide.md)           | モデル・ルール・`when`・型の昇格・`action`・DI・テストの書き方に加え、実行順序・マージ仕様・失敗の型・`cached` の挙動・`open()`・`plan()` まで実装時に必要なリファレンス |
| 設計の意図・構成・スコープ | [設計思想とスコープ (`docs/design.md`)](docs/design.md) | 解決したい課題、ドメイン層・DI層・ユースケース層の責務分割、設計原則、スコープ外（TOCTOU や複数レコード更新など）、先行事例、未決定の論点                                |

## License

未定
