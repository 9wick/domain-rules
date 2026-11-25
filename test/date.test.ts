import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import {
  alwaysAllow,
  bind,
  clock,
  model,
  modelRules,
  open,
  port,
  provide,
  rule,
  ruleset,
  always,
} from "../src/index.ts";
import { UserIdSchema, type AppActor } from "./blog/domain.ts";

const appointment = model({
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
const actor: AppActor = { id: v.parse(UserIdSchema, "usr_1"), role: "MEMBER" };
const find = port("findAppointment").of<(id: string) => { id: string; date: Date } | null>();
const keepId = rule(appointment.save, {
  name: "id",
  when: always,
  check: ({ pre }) => Result.succeed({ next: { id: pre?.id ?? "new" } }),
});

test("入力の文字列を schema で Date に変換すれば、DB が Date の項目を持つ model にも load を書ける", async () => {
  const stored = { id: "a1", date: new Date("2026-01-01T00:00:00Z") };
  const domain = bind([modelRules(appointment).load(find).save(ruleset(keepId)).delete(ruleset(alwaysAllow))], {
    providers: [provide.value(find, stored), provide.value(clock, 0)],
  });
  const moved = await domain.appointment.update({
    input: { id: "a1", date: "2026-02-01T00:00:00Z" },
    actor,
  });
  expect(open(Result.unwrap(moved)).next.date).toEqual(new Date("2026-02-01T00:00:00Z"));
  const kept = await domain.appointment.update({ input: { id: "a1" }, actor });
  expect(open(Result.unwrap(kept)).next.date).toBe(stored.date);
});
