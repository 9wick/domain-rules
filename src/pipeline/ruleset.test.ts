import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { Track } from "../definition/track.ts";
import { port } from "../port/port.ts";
import { rule } from "./rule.ts";
import { ruleset } from "./ruleset.ts";
import { always } from "./when/step.ts";

type S = { readonly n: number };
const track = new Track<"save", "item", S>("save", "item");
const inv = { scope: {}, now: 0 };

const positive = rule(track, {
  name: "正の数",
  when: always,
  check: ({ n }) => (n > 0 ? Result.succeed({ positive: true }) : Result.fail("NOT_POSITIVE")),
});
const doubled = rule(track, {
  name: "2倍",
  when: always,
  check: ({ n }) => Result.succeed({ doubled: n * 2 }),
});

test("rule を先頭から順に当て、成功の値を状態に重ねる", async () => {
  expect(await ruleset(positive).add(doubled).run({ n: 2 }, inv)).toEqual(
    Result.succeed({ n: 2, positive: true, doubled: 4 }),
  );
});

test("最初に失敗した rule の名前と失敗の値で止まり、後ろの rule は当てない", async () => {
  let called = false;
  const spy = rule(track, { name: "後ろ", when: always, check: () => ((called = true), Result.succeed()) });
  expect(await ruleset(positive).add(spy).run({ n: -1 }, inv)).toEqual(
    Result.fail({ step: "正の数", error: "NOT_POSITIVE" }),
  );
  expect(called).toBe(false);
});

test("when が当たらない rule は check を呼ばず、状態を変えない", async () => {
  let called = false;
  const never = rule(track, { name: "never", when: () => false, check: () => ((called = true), Result.fail("X")) });
  expect(await ruleset(never).add(doubled).run({ n: 1 }, inv)).toEqual(Result.succeed({ n: 1, doubled: 2 }));
  expect(called).toBe(false);
});

test("plan と ports は、足した rule の名前・when の説明・port を順に持つ", () => {
  const find = port("find").of<() => number>();
  const withPort = rule(track, { name: "port", requires: { find }, when: always, check: () => Result.succeed() });
  const rs = ruleset(positive).add(withPort);
  expect(rs.plan).toEqual([
    { name: "正の数", when: { kind: "always" }, ports: [] },
    { name: "port", when: { kind: "always" }, ports: ["find"] },
  ]);
  expect(rs.ports).toEqual([find]);
});

test("add は元の ruleset を変えず、新しい ruleset を返す", () => {
  const base = ruleset(positive);
  const added = base.add(doubled);
  expect(base.plan.map((r) => r.name)).toEqual(["正の数"]);
  expect(added.plan.map((r) => r.name)).toEqual(["正の数", "2倍"]);
});
