import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import type { DecideState } from "../definition/action.ts";
import { actionMethods, type DecideRun } from "./action-method.ts";
import { open } from "./seal.ts";
import { Context } from "../port/provider.ts";
import { invocationOf } from "../port/invocation.ts";

type Operator = { readonly role: "MEMBER" | "GUEST" };
const member: Operator = { role: "MEMBER" };
const input = v.object({ fileId: v.pipe(v.string(), v.minLength(1)) });
const ctx = { invocation: () => invocationOf(new Context([]), 7) };

// 受け取った状態を記録し、メンバーだけに URL を返す線路
const seen: DecideState<{ fileId: string }, Operator>[] = [];
const rules: DecideRun<{ fileId: string }, Operator, string, Operator, "FORBIDDEN"> = {
  run: async (s) => (
    seen.push(s),
    s.actor.role === "MEMBER"
      ? Result.succeed({ value: `/files/${s.input.fileId}`, actor: s.actor })
      : Result.fail("FORBIDDEN")
  ),
};
const { decide } = actionMethods(ctx, input, rules);

test("入力の全体を action の schema で検証する", async () => {
  const r = await decide({ input: { fileId: "" }, actor: member });
  expect(Result.unwrapError(r)).toMatchObject({ step: "input", error: { issues: [{ path: [{ key: "fileId" }] }] } });
});

test("検証した入力・actor・時刻を線路に渡し、線路が返した値と actor に封をする", async () => {
  const r = await decide({ input: { fileId: "f1" }, actor: member });
  expect(open(Result.unwrap(r))).toEqual({ value: "/files/f1", actor: member });
  expect(seen.at(-1)).toEqual({ input: { fileId: "f1" }, actor: member, now: 7 });
});

test("線路の失敗はそのまま返す", async () => {
  expect(Result.unwrapError(await decide({ input: { fileId: "f1" }, actor: { role: "GUEST" } }))).toBe("FORBIDDEN");
});
