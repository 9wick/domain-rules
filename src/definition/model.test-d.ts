import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expectTypeOf, test } from "vite-plus/test";
import { article, type UserIdExisted } from "../../test/blog/domain.ts";
import { always, model, rule } from "../index.ts";

test("model の入力スキーマは id を必須にできない", () => {
  const schema = { input: v.object({ id: v.string() }), persisted: v.object({ id: v.string() }) };
  // @ts-expect-error create は入力から id を受け取らない
  model({ name: "requiredId", schema });
});

test("assuming で前提を付けない rule の pre は永続化の型", () => {
  rule(article.onSave, {
    name: "x",
    when: always,
    check: ({ pre }) => {
      expectTypeOf(pre?.reviewerId).toEqualTypeOf<UserIdExisted | undefined>();
      return Result.succeed();
    },
  });
});
