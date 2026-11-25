import * as v from "valibot";
import { expectTypeOf, test } from "vite-plus/test";
import { defineModel, type DeleteState, type ModelActor, type SaveState } from "./model.ts";
import type { Track } from "./track.ts";

type Operator = { readonly role: "MEMBER" | "ADMIN" };

const item = defineModel<Operator>()({
  name: "item",
  schema: {
    input: v.object({ id: v.optional(v.string()), n: v.number() }),
    persisted: v.object({ id: v.string(), n: v.number() }),
  },
});
type Stored = { id: string; n: number };
type Input = { id?: string | undefined; n: number };

test("保存の線路は、永続化の型か null の pre、入力の型の next、actor を状態に持つ", () => {
  expectTypeOf(item.onSave).toEqualTypeOf<Track<"save", "item", SaveState<Stored | null, Input, Operator>>>();
});

test("削除の線路は、永続化の型の pre と actor を状態に持つ", () => {
  expectTypeOf(item.onDelete).toEqualTypeOf<Track<"delete", "item", DeleteState<Stored, Operator>>>();
});

test("ModelActor は model を作ったときの actor の型", () => {
  expectTypeOf<ModelActor<typeof item>>().toEqualTypeOf<Operator>();
});

test("入力スキーマは id を必須にできない", () => {
  const schema = { input: v.object({ id: v.string() }), persisted: v.object({ id: v.string() }) };
  // @ts-expect-error create は入力から id を受け取らない
  defineModel<Operator>()({ name: "requiredId", schema });
});
