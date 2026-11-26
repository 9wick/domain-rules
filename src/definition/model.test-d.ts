import * as v from "valibot";
import { z } from "zod";
import { describe, expectTypeOf, test } from "vite-plus/test";
import { defineModel, type DeleteState, type ModelActor, type SaveState } from "./model.ts";
import type { Track } from "./track.ts";

type Operator = { readonly role: "MEMBER" | "ADMIN" };

const item = defineModel<Operator>()({
  name: "item",
  schema: {
    key: v.object({ id: v.optional(v.string()) }),
    value: v.object({ n: v.number() }),
    persisted: v.object({ id: v.string(), n: v.number() }),
  },
});
type Stored = { id: string; n: number };
type Key = { id?: string | undefined };

test("保存の線路は、永続化の型か null の pre、key と value を合わせた next、actor を状態に持つ", () => {
  expectTypeOf(item.onSave).toEqualTypeOf<
    Track<"save", "item", SaveState<Stored | null, { id?: string | undefined } & { n: number }, Operator>>
  >();
});

test("削除の線路は、永続化の型の pre、key の型の input、actor を状態に持つ", () => {
  expectTypeOf(item.onDelete).toEqualTypeOf<Track<"delete", "item", DeleteState<Stored, Key, Operator>>>();
});

test("ModelActor は model を作ったときの actor の型", () => {
  expectTypeOf<ModelActor<typeof item>>().toEqualTypeOf<Operator>();
});

test("key の schema は id を必須にできない", () => {
  const schema = { key: v.object({ id: v.string() }), value: v.object({}), persisted: v.object({ id: v.string() }) };
  // @ts-expect-error create は入力から id を受け取らない
  defineModel<Operator>()({ name: "requiredId", schema });
});

test("schema の optional には既定値を書けない", () => {
  const schema = {
    key: v.object({ id: v.optional(v.string()) }),
    value: v.object({ status: v.optional(v.string(), "DRAFT") }),
    persisted: v.object({ id: v.string(), status: v.string() }),
  };
  // @ts-expect-error 既定値はルールで next に入れる
  defineModel<Operator>()({ name: "defaulted", schema });
});

test("key と value に同じ項目は書けない", () => {
  const schema = {
    key: v.object({ id: v.optional(v.string()), tenantId: v.string() }),
    value: v.object({ tenantId: v.string() }),
    persisted: v.object({ id: v.string(), tenantId: v.string() }),
  };
  // @ts-expect-error next でどちらの値が残るかが決まらない
  defineModel<Operator>()({ name: "overlapped", schema });
});

describe("Zod の schema", () => {
  test("Zod の object も key と value に書け、線路の状態はその出力の型になる", () => {
    const zodItem = defineModel<Operator>()({
      name: "zodItem",
      schema: {
        key: z.object({ id: z.string().optional() }),
        value: z.object({ n: z.number() }),
        persisted: z.object({ id: z.string(), n: z.number() }),
      },
    });
    expectTypeOf(zodItem.onSave).toEqualTypeOf<
      Track<"save", "zodItem", SaveState<Stored | null, { id?: string | undefined } & { n: number }, Operator>>
    >();
  });

  test("Zod でも optional に既定値は書けない", () => {
    const schema = {
      key: z.object({ id: z.string().optional() }),
      value: z.object({ status: z.string().default("DRAFT") }),
      persisted: z.object({ id: z.string(), status: z.string() }),
    };
    // @ts-expect-error 既定値はルールで next に入れる
    defineModel<Operator>()({ name: "defaulted", schema });
  });
});
