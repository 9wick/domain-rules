import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { UserIdSchema, type AppActor } from "../../test/blog/domain.ts";
import { alwaysAllow, always, bind, cached, clock, model, modelRules, port, provide, rule, ruleset } from "../index.ts";

// ライブラリの部品ごとのテストで共有する、最小の model と rule

export const member: AppActor = { id: v.parse(UserIdSchema, "usr_1"), role: "MEMBER" };

export const item = model({
  name: "item",
  schema: {
    input: v.object({ id: v.optional(v.string()), n: v.number() }),
    persisted: v.object({ id: v.string(), n: v.number() }),
  },
});
export const lookup = cached(port("lookup").of<(n: number) => number>());
export const uncachedLookup = port("uncachedLookup").of<(n: number) => number>();

export const twice = (name: string) =>
  rule(item.onSave, {
    name,
    requires: { lookup, uncachedLookup },
    when: always,
    check: async ({ next }, ports) => {
      await ports.lookup(next.n);
      await ports.uncachedLookup(next.n);
      return Result.succeed({ next: { id: "i" } });
    },
  });

export const stored = { id: "i1", n: 5 };
export const findItem = port("findItem").of<(id: string) => { id: string; n: number } | null, "DB_DOWN">();
export const assignId = rule(item.onSave, {
  name: "id",
  when: always,
  check: ({ next }) => Result.succeed({ next: { id: next.id ?? "new" } }),
});
const seenNow = rule(item.onSave, {
  name: "now",
  when: always,
  check: ({ now }) => (now === 42 ? Result.succeed() : Result.fail("WRONG_NOW")),
});
export const itemRules = modelRules(item)
  .load(findItem)
  .save(ruleset(seenNow).add(assignId))
  .delete(ruleset(alwaysAllow));
export const itemDomain = (load: () => Result.Result<{ id: string; n: number } | null, "DB_DOWN">) =>
  bind([itemRules], { providers: [provide(findItem, load), provide.value(clock, 42)] }).item;
