import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { Track } from "../definition/track.ts";
import { invocationOf } from "../port/invocation.ts";
import { Context } from "../port/provider.ts";
import { emit } from "./emit.ts";

type S = { readonly n: number };
const track = new Track<"save", "item", S>("save", "item");

test("emit は状態を変えず失敗しない rule で、event は渡された状態からイベントを作る", async () => {
  const e = emit(track, {
    id: "positive",
    description: "正の数",
    when: (s) => s.n > 0,
    event: (s) => ({ type: "POSITIVE", n: s.n }),
  });
  expect(await e.run({ n: 1 }, invocationOf(new Context([]), 0))).toEqual(Result.succeed());
  expect(e.event?.({ n: 3 })).toEqual({ type: "POSITIVE", n: 3 });
  expect(e.ports).toEqual([]);
  expect(e.when({ n: 0 })).toBe(false);
});
