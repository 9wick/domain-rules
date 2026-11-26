import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { pickEntries, unknownKeys, validate, validatePartial, validateWhole } from "./validate.ts";

const schema = v.object({ n: v.number(), label: v.optional(v.string()) });

test("validate は schema の問題に、渡した path を前に付ける", async () => {
  const r = await validate(v.number(), "x", ["n"]);
  expect(Result.unwrapError(r)).toMatchObject([{ path: ["n"] }]);
  expect(await validate(v.number(), 1)).toEqual(Result.succeed(1));
});

test("validateWhole は schema で検証し、undefined の項目は無いものとして扱う", async () => {
  expect(await validateWhole(schema, { n: 1, label: undefined })).toEqual(Result.succeed({ n: 1 }));
  expect(Result.unwrapError(await validateWhole(schema, {}))).toMatchObject([{ path: [{ key: "n" }] }]);
});

test("validatePartial は入力にある項目だけを、その項目の schema で検証する", async () => {
  expect(await validatePartial(schema.entries, { label: "a" })).toEqual(Result.succeed({ label: "a" }));
  expect(Result.unwrapError(await validatePartial(schema.entries, { n: "x" }))).toMatchObject([{ path: ["n"] }]);
});

test("pickEntries は schema の項目だけを取り出し、prototype の名前の項目は取り出さない", () => {
  expect(pickEntries(schema.entries, { n: 1, extra: 1, constructor: 1 })).toEqual({ n: 1 });
});

test("unknownKeys は受け付けない項目を、項目ごとの問題にする", () => {
  expect(unknownKeys({ n: 1, extra: 1 }, (key) => key === "n")).toMatchObject([{ path: ["extra"] }]);
});
