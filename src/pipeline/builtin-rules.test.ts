import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { Track } from "../definition/track.ts";
import { alwaysAllow, defaultFields, immutable } from "./builtin-rules.ts";
import { Context } from "../port/provider.ts";
import { invocationOf } from "../port/invocation.ts";

type Item = { readonly slug: string; readonly title: string; readonly n: number };
type S = { readonly pre: Item | null; readonly next: Item };
const track = new Track<"save", "item", S>("save", "item");
const item: Item = { slug: "a", title: "t", n: 1 };
const inv = invocationOf(new Context([]), 0);

const fixed = immutable(track, ["slug", "n"]);

test("immutable は作成後に、指定した項目が変わったら最初に変わった項目で失敗する", async () => {
  const changed: S = { pre: item, next: { ...item, slug: "b", n: 2 } };
  expect(fixed.when(changed)).toBe(true);
  expect(await fixed.run(changed, inv)).toEqual(Result.fail({ code: "IMMUTABLE_FIELD_CHANGED", field: "slug" }));
});

test("immutable は作成時と、指定していない項目だけが変わったときは当たらない", () => {
  expect(fixed.when({ pre: null, next: item })).toBe(false);
  expect(fixed.when({ pre: item, next: { ...item, title: "u" } })).toBe(false);
});

test("immutable の識別子は項目によらず同じで、説明は指定した項目を表す", () => {
  expect(fixed.id).toBe("immutable");
  expect(fixed.description).toBe("fields immutable after creation: slug, n");
  expect(fixed.when.description).toEqual({
    kind: "and",
    conditions: [
      { kind: "not", condition: { kind: "onCreate" } },
      {
        kind: "or",
        conditions: [
          { kind: "changed", field: "slug" },
          { kind: "changed", field: "n" },
        ],
      },
    ],
  });
});

test("immutable に id を渡すと、説明と判定はそのままで id だけが変わる", () => {
  const named = immutable(track, ["slug", "n"], { id: "slugAndNFixed" });
  expect(named.id).toBe("slugAndNFixed");
  expect(named.description).toBe(fixed.description);
  expect(named.when.description).toEqual(fixed.when.description);
});

test("alwaysAllow は常に当たり、何も確かめずに成功する", async () => {
  expect(alwaysAllow.when.description).toEqual({ kind: "always" });
  expect(await alwaysAllow.run(undefined, inv)).toEqual(Result.succeed());
  expect(alwaysAllow.ports).toEqual([]);
});

type Draft = { readonly title?: string; readonly memo?: string | null; readonly n: number };
type Stored = { readonly title: string; readonly memo: string | null; readonly n: number };
type DraftState = { readonly pre: Stored | null; readonly next: Draft; readonly now: number };
const draftTrack = new Track<"save", "draft", DraftState, "id">("save", "draft");
const withDefaults = defaultFields(draftTrack, { title: (s) => `untitled_${s.now}`, memo: null });

test("defaultFields は作成時に、省略した項目にだけ既定値を入れる。関数は状態から値を作る", async () => {
  const created = await withDefaults.run({ pre: null, next: { n: 1 }, now: 42 }, inv);
  expect(created).toEqual(Result.succeed({ next: { title: "untitled_42", memo: null } }));
  const given = await withDefaults.run({ pre: null, next: { n: 1, title: "t", memo: "m" }, now: 42 }, inv);
  expect(given).toEqual(Result.succeed({ next: {} }));
});

test("defaultFields は null を指定した項目を上書きしない", async () => {
  const r = await withDefaults.run({ pre: null, next: { n: 1, title: "t", memo: null }, now: 0 }, inv);
  expect(r).toEqual(Result.succeed({ next: {} }));
});

test("defaultFields は更新では何もしない", async () => {
  const stored: Stored = { title: "t", memo: "m", n: 1 };
  const r = await withDefaults.run({ pre: stored, next: stored, now: 0 }, inv);
  expect(r).toEqual(Result.succeed());
});

test("defaultFields は常に当たり、識別子は既定で defaultFields、説明は指定した項目を表す", () => {
  expect(withDefaults.id).toBe("defaultFields");
  expect(withDefaults.description).toBe("defaults for fields omitted on create: title, memo");
  expect(withDefaults.when.description).toEqual({ kind: "always" });
  expect(defaultFields(draftTrack, { memo: null }, { id: "memoDefault" }).id).toBe("memoDefault");
});
