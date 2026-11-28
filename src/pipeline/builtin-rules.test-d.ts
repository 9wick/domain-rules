import { expectTypeOf, test } from "vite-plus/test";
import { Track } from "../definition/track.ts";
import { immutable } from "./builtin-rules.ts";

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
