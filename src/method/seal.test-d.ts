import * as v from "valibot";
import { expectTypeOf, test } from "vite-plus/test";
import { defineAction } from "../definition/action.ts";
import { defineModel } from "../definition/model.ts";
import { open, type Decision, type Deletable, type Persistable } from "./seal.ts";

type Operator = { readonly role: "MEMBER" };
const item = defineModel<Operator>()({
  name: "item",
  schema: {
    key: v.object({ id: v.optional(v.string()) }),
    value: v.object({}),
    persisted: v.object({ id: v.string() }),
  },
});
const download = defineAction<Operator>()({ name: "download", input: v.object({ fileId: v.string() }) });

declare const updated: Persistable<typeof item, "update">;
declare const saved: Persistable<typeof item>;
declare const deleted: Deletable<typeof item>;
declare const decided: Decision<typeof download>;

test("型引数を省くと、pre は永続化の型、actor は model や action を作った domain の actor の型", () => {
  expectTypeOf(open(updated)).toEqualTypeOf<{
    readonly pre: Readonly<{ id: string }>;
    readonly next: Readonly<{ id: string }>;
    readonly actor: Operator;
  }>();
  expectTypeOf(open(deleted).actor).toEqualTypeOf<Operator>();
  expectTypeOf(open(decided)).toEqualTypeOf<{ readonly value: void; readonly actor: Operator }>();
});

test("create と update のどちらもありうる値は、pre が null の中身との和になる", () => {
  expectTypeOf(open(saved).pre).toEqualTypeOf<Readonly<{ id: string }> | null>();
});
