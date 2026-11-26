import { expectTypeOf, test } from "vite-plus/test";
import type { SaveState } from "../../definition/model.ts";
import type { When } from "./when.ts";
import { actor, and, changed, given, next, pre } from "./builders.ts";

type Item = { readonly status: string };

test("changed と next は保存の線路だけ、pre は保存と削除の線路で使える", () => {
  // @ts-expect-error changed は削除の線路で使えない
  const onDelete: When<"delete", { readonly pre: Item | null; readonly next: Item }> = changed("status");
  // @ts-expect-error next は削除の線路で使えない
  const nextOnDelete: When<"delete", { readonly next: Item }> = next((v: Item) => v.status === "DRAFT");
  const preOnDelete: When<"delete", { readonly pre: Item | null }> = pre((v: Item) => v.status === "DRAFT");
  expectTypeOf([onDelete, nextOnDelete, preOnDelete]).not.toBeNever();
});

test("and は、並べた when のどれでも使える線路だけで使える", () => {
  // @ts-expect-error changed を含むので削除の線路で使えない
  const both: When<"delete", { readonly pre: Item | null; readonly next: Item }> = and(
    changed("status"),
    pre((v: Item) => v.status === "DRAFT"),
  );
  expectTypeOf(both).not.toBeNever();
});

test("actor の型は述語の引数から決まり、状態の actor に求める", () => {
  const admin = actor((a: { readonly role: string }) => a.role === "ADMIN");
  admin({ actor: { role: "ADMIN" } });
  // @ts-expect-error actor の型が述語の引数と合わない
  admin({ actor: { name: "x" } });
});

test("given は保存の線路だけで使え、next にない項目名は型エラー", () => {
  type Saving = SaveState<Item | null, Item, unknown>;
  const status: When<"save", Saving> = given("status");
  // @ts-expect-error given は削除の線路で使えない
  const onDelete: When<"delete", Saving> = given("status");
  // @ts-expect-error title は Item にない
  const unknownField: When<"save", Saving> = given("title");
  expectTypeOf([status, onDelete, unknownField]).not.toBeNever();
});
