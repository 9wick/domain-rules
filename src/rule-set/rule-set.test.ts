import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { defineAction } from "../definition/action.ts";
import { defineModel } from "../definition/model.ts";
import { rule } from "../pipeline/rule.ts";
import { ruleset } from "../pipeline/ruleset.ts";
import { always } from "../pipeline/when/step.ts";
import { actionRules } from "./action-rules.ts";
import { modelRules } from "./model-rules.ts";
import { plan } from "./rule-set.ts";

test("plan は model の rule の組なら save と delete の線路を、action なら判定の線路を返す", () => {
  const item = defineModel<unknown>()({
    name: "item",
    schema: {
      key: v.object({ id: v.optional(v.string()) }),
      value: v.object({}),
      persisted: v.object({ id: v.string() }),
    },
  });
  const assignId = rule(item.onSave, {
    id: "id",
    description: "id",
    when: always,
    check: () => Result.succeed({ next: { id: "i" } }),
  });
  expect(plan(modelRules(item).save(ruleset(assignId)))).toEqual({
    save: [{ id: "id", description: "id", when: { kind: "always" }, ports: [] }],
  });

  const ping = defineAction<unknown>()({ name: "ping", input: v.object({}) });
  const pong = rule(ping.onDecide, { id: "pong", description: "pong", when: always, check: () => Result.succeed() });
  expect(plan(actionRules(ping, { rules: ruleset(pong), output: () => "pong" }))).toEqual({
    rules: [{ id: "pong", description: "pong", when: { kind: "always" }, ports: [] }],
  });
});
