import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { defineAction } from "./action.ts";

test("action は名前と入力スキーマを持ち、判定の線路をその名前で作る", () => {
  const input = v.object({ fileId: v.string() });
  const download = defineAction<unknown>()({ name: "download", input });
  expect(download.name).toBe("download");
  expect(download.input).toBe(input);
  expect([download.onDecide.kind, download.onDecide.target]).toEqual(["decide", "download"]);
  expect(Object.isFrozen(download)).toBe(true);
});
