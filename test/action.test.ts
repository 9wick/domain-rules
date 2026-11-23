import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { action, actionRules, always, bind, clock, open, plan, provide, rule } from "../src/index.ts";

const download = action({ name: "download", input: v.object({ fileId: v.pipe(v.string(), v.minLength(1)) }) });
const member = { id: "usr_1" as never, role: "MEMBER" } as const;

const allowed = rule(download.decide, {
  name: "メンバーだけ",
  when: always,
  check: ({ actor, input }) => (actor.role === "MEMBER" ? Result.succeed({ url: `/files/${input.fileId}` }) : Result.fail("FORBIDDEN")),
});

const domain = bind(
  [
    actionRules(download, { rules: [allowed], output: ({ url }) => url }),
  ],
  { providers: [provide.value(clock, 0)] },
);

test("入力の全体を action の schema で検証する", async () => {
  const r = await domain.download.decide({ input: { fileId: "" }, actor: member });
  expect(Result.unwrapError(r)).toMatchObject({ step: "input", error: { issues: [{ path: [{ key: "fileId" }] }] } });
});

test("output の値と actor を封をした値で返す", async () => {
  const r = await domain.download.decide({ input: { fileId: "f1" }, actor: member });
  expect(open(Result.unwrap(r))).toEqual({ value: "/files/f1", actor: member });
});

test("rule の失敗で止まる", async () => {
  const r = await domain.download.decide({ input: { fileId: "f1" }, actor: { ...member, role: "GUEST" } });
  expect(Result.unwrapError(r)).toEqual({ step: "メンバーだけ", error: "FORBIDDEN" });
});

test("output を省略すると value は undefined", async () => {
  const bare = bind([actionRules(download, { rules: [allowed] })], { providers: [provide.value(clock, 0)] });
  expect(open(Result.unwrap(await bare.download.decide({ input: { fileId: "f1" }, actor: member }))).value).toBeUndefined();
});

test("plan は action の線路も表示する", () => {
  expect(plan(actionRules(download, { rules: [allowed] }))).toEqual({
    rules: [{ name: "メンバーだけ", when: { kind: "always" }, ports: [] }],
  });
});
