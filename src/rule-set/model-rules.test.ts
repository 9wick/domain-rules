import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { defineModel } from "../definition/model.ts";
import { open } from "../method/seal.ts";
import { alwaysAllow } from "../pipeline/builtin-rules.ts";
import { rule } from "../pipeline/rule.ts";
import { ruleset } from "../pipeline/ruleset.ts";
import { always } from "../pipeline/when/step.ts";
import { port } from "../port/port.ts";
import { modelRules } from "./model-rules.ts";

type Operator = { readonly name: string };
const operator: Operator = { name: "op" };

const item = defineModel<Operator>()({
  name: "item",
  schema: {
    input: v.object({ id: v.optional(v.string()), n: v.number() }),
    persisted: v.object({ id: v.string(), n: v.number() }),
  },
});
const findItem = port("findItem").of<(id: string) => { id: string; n: number } | null>();
const assignId = rule(item.onSave, {
  name: "id を付ける",
  when: always,
  check: ({ pre }) => Result.succeed({ next: { id: pre?.id ?? "new" } }),
});
const save = ruleset(assignId);

const ctxWith = (stored: { id: string; n: number } | null) => {
  const scope = {};
  findItem.valued(stored).registerIn(scope);
  return { invocation: () => ({ scope, now: 0 }) };
};

test("load を書かずに save を書いた rule の組は create だけを持つ", () => {
  const set = modelRules(item).save(save);
  expect(Object.keys(set.resolveIn(ctxWith(null)))).toEqual(["create"]);
  expect(set.plans).toEqual({ save: save.plan });
});

test("load と save を書くと create・update・upsert を、delete を書くと delete を持つ", () => {
  const saved = modelRules(item).load(findItem).save(save);
  expect(Object.keys(saved.resolveIn(ctxWith(null)))).toEqual(["create", "update", "upsert"]);
  const both = saved.delete(ruleset(alwaysAllow));
  expect(Object.keys(both.resolveIn(ctxWith(null)))).toEqual(["create", "update", "upsert", "delete"]);
  expect(both.plans).toEqual({ save: save.plan, delete: ruleset(alwaysAllow).plan });
});

test("ports は load と、save・delete の線路が使う port を持つ", () => {
  const audit = port("audit").of<() => void>();
  const audited = rule(item.onDelete, {
    name: "監査",
    requires: { audit },
    when: always,
    check: () => Result.succeed(),
  });
  const set = modelRules(item).load(findItem).save(save).delete(ruleset(audited));
  expect(set.ports).toEqual([findItem, audit]);
});

test("メソッドは load で読んだ既存の値から、save の線路を通す", async () => {
  const { update } = modelRules(item)
    .load(findItem)
    .save(save)
    .resolveIn(ctxWith({ id: "i1", n: 1 }));
  const r = await update({ input: { id: "i1", n: 2 }, actor: operator });
  expect(open(Result.unwrap(r))).toEqual({ pre: { id: "i1", n: 1 }, next: { id: "i1", n: 2 }, actor: operator });
});

test("入力の文字列を schema で Date に変換すれば、Date の項目を持つ model にも load を書ける", async () => {
  const appointment = defineModel<Operator>()({
    name: "appointment",
    schema: {
      input: v.object({
        id: v.optional(v.string()),
        date: v.pipe(
          v.string(),
          v.isoTimestamp(),
          v.transform((s) => new Date(s)),
        ),
      }),
      persisted: v.object({ id: v.string(), date: v.date() }),
    },
  });
  const find = port("findAppointment").of<(id: string) => { id: string; date: Date } | null>();
  const keepId = rule(appointment.onSave, {
    name: "id",
    when: always,
    check: ({ pre }) => Result.succeed({ next: { id: pre?.id ?? "new" } }),
  });
  const stored = { id: "a1", date: new Date("2026-01-01T00:00:00Z") };
  const scope = {};
  find.valued(stored).registerIn(scope);
  const { update } = modelRules(appointment)
    .load(find)
    .save(ruleset(keepId))
    .resolveIn({ invocation: () => ({ scope, now: 0 }) });
  const moved = await update({ input: { id: "a1", date: "2026-02-01T00:00:00Z" }, actor: operator });
  expect(open(Result.unwrap(moved)).next.date).toEqual(new Date("2026-02-01T00:00:00Z"));
  const kept = await update({ input: { id: "a1" }, actor: operator });
  expect(open(Result.unwrap(kept)).next.date).toBe(stored.date);
});
