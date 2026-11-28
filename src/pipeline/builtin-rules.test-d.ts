import { expectTypeOf, test } from "vite-plus/test";
import { Track } from "../definition/track.ts";
import { defaultFields, immutable } from "./builtin-rules.ts";

type S = { readonly pre: { readonly slug: string } | null; readonly next: { readonly slug: string } };

test("immutable には next にある項目だけを渡せる", () => {
  const track = new Track<"save", "item", S>("save", "item");
  immutable(track, ["slug"]);
  // @ts-expect-error 存在しない項目
  immutable(track, ["slugg"]);
});

test("immutable は保存の線路だけで使える", () => {
  const onDelete = new Track<"delete", "item", S>("delete", "item");
  // @ts-expect-error 削除の線路では項目は変わらない
  immutable(onDelete, ["slug"]);
});

test("immutable の id は既定で immutable で、渡した id はリテラル型のまま失敗の step になる", () => {
  const track = new Track<"save", "item", S>("save", "item");
  expectTypeOf(immutable(track, ["slug"]).id).toEqualTypeOf<"immutable">();
  expectTypeOf(immutable(track, ["slug"], { id: "slugIsFixed" }).id).toEqualTypeOf<"slugIsFixed">();
});

type Draft = {
  readonly id?: string;
  readonly title?: string;
  readonly memo?: string | null;
  readonly note?: string;
  readonly n: number;
};
type Stored = { readonly id: string; readonly title: string; readonly memo: string | null; readonly n: number };
type DraftState = { readonly pre: Stored | null; readonly next: Draft; readonly now: number };
const draftTrack = new Track<"save", "draft", DraftState, "id">("save", "draft");

test("defaultFields には、value で省略できて永続化の型では必ずある項目だけを、その型の値か値を作る関数で渡せる", () => {
  defaultFields(draftTrack, { title: "t", memo: (s) => `${s.now}` });
  // @ts-expect-error 省略できない項目には既定値は使われない
  defaultFields(draftTrack, { n: 1 });
  // @ts-expect-error 永続化の型でも省略できる項目は、作成時に入れても更新後に値がある型にできない
  defaultFields(draftTrack, { note: "x" });
  // @ts-expect-error key の項目は採番などのルールで入れる
  defaultFields(draftTrack, { id: "x" });
  // @ts-expect-error 項目の型と合わない値
  defaultFields(draftTrack, { title: 1 });
  // @ts-expect-error 値を作る関数も項目の型を返す
  defaultFields(draftTrack, { title: (s) => s.now });
});

test("defaultFields を通ったあとは、渡した項目が値のある型に昇格し、失敗しない", () => {
  const r = defaultFields(draftTrack, { title: "t", memo: null });
  type Run = Awaited<ReturnType<typeof r.run>>;
  expectTypeOf<Extract<Run, { type: "Success" }>["value"]>().toEqualTypeOf<{
    readonly next: { readonly title: string; readonly memo: string | null };
  }>();
  expectTypeOf<Extract<Run, { type: "Failure" }>["error"]>().toBeNever();
});

test("defaultFields の id は既定で defaultFields で、渡した id はリテラル型のまま失敗の step になる", () => {
  expectTypeOf(defaultFields(draftTrack, { title: "t" }).id).toEqualTypeOf<"defaultFields">();
  expectTypeOf(defaultFields(draftTrack, { title: "t" }, { id: "titleDefault" }).id).toEqualTypeOf<"titleDefault">();
});

test("defaultFields は保存の線路だけで使える", () => {
  const onDelete = new Track<"delete", "draft", DraftState, "id">("delete", "draft");
  // @ts-expect-error 削除の線路では値を作らない
  defaultFields(onDelete, { title: "t" });
});
