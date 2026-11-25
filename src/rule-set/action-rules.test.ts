import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { defineAction } from "../definition/action.ts";
import { open } from "../method/seal.ts";
import { rule } from "../pipeline/rule.ts";
import { ruleset } from "../pipeline/ruleset.ts";
import { always } from "../pipeline/when/step.ts";
import { actionRules } from "./action-rules.ts";

type Operator = { readonly role: "MEMBER" | "GUEST" };
const member: Operator = { role: "MEMBER" };

const download = defineAction<Operator>()({ name: "download", input: v.object({ fileId: v.string() }) });
const allowed = rule(download.onDecide, {
  name: "メンバーだけ",
  when: always,
  check: ({ actor, input }) =>
    actor.role === "MEMBER" ? Result.succeed({ url: `/files/${input.fileId}` }) : Result.fail("FORBIDDEN"),
});
const set = actionRules(download, { rules: ruleset(allowed), output: ({ url }) => url });
const { decide } = set.resolveIn({ invocation: () => ({ scope: {}, now: 0 }) });

test("output が線路の最後の状態から組み立てた値と actor を、封をした値で返す", async () => {
  const r = await decide({ input: { fileId: "f1" }, actor: member });
  expect(open(Result.unwrap(r))).toEqual({ value: "/files/f1", actor: member });
});

test("線路の失敗はそのまま返し、output は呼ばない", async () => {
  const r = await decide({ input: { fileId: "f1" }, actor: { role: "GUEST" } });
  expect(Result.unwrapError(r)).toEqual({ step: "メンバーだけ", error: "FORBIDDEN" });
});

test("rule の組は action の名前と線路の plan を持つ", () => {
  expect([set.kind, set.name, set.action]).toEqual(["actionRules", "download", download]);
  expect(set.rules.plan).toEqual([{ name: "メンバーだけ", when: { kind: "always" }, ports: [] }]);
});
