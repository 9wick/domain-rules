import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { Track } from "../definition/track.ts";
import { alwaysAllow, immutable } from "./builtin-rules.ts";
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
  expect(fixed.description).toBe("作成後に変えられない項目: slug, n");
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
