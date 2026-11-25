import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { validate, validatePartial, validateWhole } from "./validate.ts";

const schema = v.object({ id: v.optional(v.string()), n: v.number(), label: v.optional(v.string()) });

test("validate は schema の問題に、渡した path を前に付ける", async () => {
  const r = await validate(v.number(), "x", ["n"]);
  expect(Result.unwrapError(r)).toMatchObject([{ path: ["n"] }]);
  expect(await validate(v.number(), 1)).toEqual(Result.succeed(1));
});

test("validateWhole は schema で検証し、undefined の項目は無いものとして扱う", async () => {
  expect(await validateWhole(schema, { n: 1, label: undefined })).toEqual(Result.succeed({ n: 1 }));
});

test("validateWhole は、schema にない項目・id・schema の問題をすべて input の失敗で返す", async () => {
  const r = await validateWhole(schema, { id: "x", n: "x", extra: 1 });
  expect(Result.unwrapError(r)).toMatchObject({
    step: "input",
    error: { issues: [{ path: ["id"] }, { path: ["extra"] }, { path: [{ key: "n" }] }] },
  });
});

test("prototype の名前の項目も schema にない項目として失敗する", async () => {
  const r = await validateWhole(schema, { n: 1, constructor: 1 });
  expect(Result.unwrapError(r)).toMatchObject({ step: "input", error: { issues: [{ path: ["constructor"] }] } });
});

test("validatePartial は入力にある項目だけを、その項目の schema で検証する", async () => {
  expect(await validatePartial(schema.entries, { id: "i1" })).toEqual(Result.succeed({ id: "i1" }));
  const r = await validatePartial(schema.entries, { n: "x", extra: 1 });
  expect(Result.unwrapError(r)).toMatchObject({
    step: "input",
    error: { issues: [{ path: ["extra"] }, { path: ["n"] }] },
  });
});
