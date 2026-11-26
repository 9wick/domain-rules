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
    key: v.object({ id: v.optional(v.string()) }),
    value: v.object({ n: v.number() }),
    persisted: v.object({ id: v.string(), n: v.number() }),
  },
});
const findItem = port("findItem").of<(id: string) => { id: string; n: number }>();
const assignId = rule(item.onSave, {
  name: "id を付ける",
  when: always,
  check: ({ pre }) => Result.succeed({ next: { id: pre?.id ?? "new" } }),
});
const save = ruleset(assignId);

const ctxWith = (stored: { id: string; n: number }) => {
  const scope = {};
  findItem.valued(stored).registerIn(scope);
  return { invocation: () => ({ scope, now: 0 }) };
};
const stored = { id: "i1", n: 1 };

const loaded = () =>
  modelRules(item).load({ requires: { findItem }, fetch: ({ input }, { findItem }) => findItem(input.id) });

test("load を書かずに save を書いた rule の組は create だけを持つ", () => {
  const set = modelRules(item).save(save);
  expect(Object.keys(set.resolveIn(ctxWith(stored)))).toEqual(["create"]);
  expect(set.plans).toEqual({ save: save.plan });
});

test("load と save を書くと create・update・upsert を、delete を書くと delete を持つ", () => {
  const saved = loaded().save(save);
  expect(Object.keys(saved.resolveIn(ctxWith(stored)))).toEqual(["create", "update", "upsert"]);
  const both = saved.delete(ruleset(alwaysAllow));
  expect(Object.keys(both.resolveIn(ctxWith(stored)))).toEqual(["create", "update", "upsert", "delete"]);
  expect(both.plans).toEqual({
    load: { ports: ["findItem"] },
    save: save.plan,
    delete: ruleset(alwaysAllow).plan,
  });
});

test("ports は load と、save・delete の線路が使う port を持つ", () => {
  const audit = port("audit").of<() => void>();
  const audited = rule(item.onDelete, {
    name: "監査",
    requires: { audit },
    when: always,
    check: () => Result.succeed(),
  });
  const set = loaded().save(save).delete(ruleset(audited));
  expect(set.ports).toEqual([findItem, audit]);
});

test("メソッドは load で読んだ既存の値から、save の線路を通す", async () => {
  const { update } = loaded().save(save).resolveIn(ctxWith(stored));
  const r = await update({ input: { id: "i1", n: 2 }, actor: operator });
  expect(open(Result.unwrap(r))).toEqual({ pre: stored, next: { id: "i1", n: 2 }, actor: operator });
});

test("取得ステップは id 以外の値も取得条件に使え、その失敗が load の失敗になる", async () => {
  const findOwned = port("findOwned").of<(owner: string, id: string) => { id: string; n: number }, "NOT_OWNED">();
  const scope = {};
  findOwned
    .provider((owner, id) => (owner === "op" ? Result.succeed({ id, n: 1 }) : Result.fail("NOT_OWNED")))
    .registerIn(scope);
  const { update } = modelRules(item)
    .load({
      requires: { findOwned },
      fetch: ({ input, actor }, { findOwned }) => findOwned(actor.name, input.id),
    })
    .save(save)
    .resolveIn({ invocation: () => ({ scope, now: 0 }) });
  const owned = await update({ input: { id: "i1", n: 2 }, actor: operator });
  expect(open(Result.unwrap(owned)).pre).toEqual({ id: "i1", n: 1 });
  const other = await update({ input: { id: "i1", n: 2 }, actor: { name: "someone" } });
  expect(Result.unwrapError(other)).toEqual({ step: "load", error: "NOT_OWNED" });
});

test("fetch も rule の check と同じく、safeTry で port の失敗を止められる", async () => {
  const findOwner = port("findOwner").of<(id: string) => string, "NO_OWNER">();
  const scope = {};
  findItem.valued(stored).registerIn(scope);
  findOwner.provider((id) => (id === "i1" ? Result.succeed("op") : Result.fail("NO_OWNER"))).registerIn(scope);
  const { update } = modelRules(item)
    .load({
      requires: { findOwner, findItem },
      fetch: ({ input }, _, { safeTry }) =>
        safeTry(async function* ({ findOwner, findItem }) {
          yield* findOwner(input.id);
          return Result.succeed(yield* findItem(input.id));
        }),
    })
    .save(save)
    .resolveIn({ invocation: () => ({ scope, now: 0 }) });
  expect(open(Result.unwrap(await update({ input: { id: "i1" }, actor: operator }))).pre).toEqual(stored);
  expect(Result.unwrapError(await update({ input: { id: "i2" }, actor: operator }))).toEqual({
    step: "load",
    error: "NO_OWNER",
  });
});

test("文字列を Date に変換し、Date もそのまま受け付ける schema なら、Date の項目を持つ model を更新できる", async () => {
  const appointment = defineModel<Operator>()({
    name: "appointment",
    schema: {
      key: v.object({ id: v.optional(v.string()) }),
      value: v.object({
        // update では重ねた値をもう一度通すので、変換後の Date も受け付ける
        date: v.union([
          v.date(),
          v.pipe(
            v.string(),
            v.isoTimestamp(),
            v.transform((s) => new Date(s)),
          ),
        ]),
      }),
      persisted: v.object({ id: v.string(), date: v.date() }),
    },
  });
  const find = port("findAppointment").of<(id: string) => { id: string; date: Date }>();
  const keepId = rule(appointment.onSave, {
    name: "id",
    when: always,
    check: ({ pre }) => Result.succeed({ next: { id: pre?.id ?? "new" } }),
  });
  const stored = { id: "a1", date: new Date("2026-01-01T00:00:00Z") };
  const scope = {};
  find.valued(stored).registerIn(scope);
  const { update } = modelRules(appointment)
    .load({ requires: { find }, fetch: ({ input }, { find }) => find(input.id) })
    .save(ruleset(keepId))
    .resolveIn({ invocation: () => ({ scope, now: 0 }) });
  const moved = await update({ input: { id: "a1", date: "2026-02-01T00:00:00Z" }, actor: operator });
  expect(open(Result.unwrap(moved)).next.date).toEqual(new Date("2026-02-01T00:00:00Z"));
  const kept = await update({ input: { id: "a1" }, actor: operator });
  expect(open(Result.unwrap(kept)).next.date).toBe(stored.date);
});
