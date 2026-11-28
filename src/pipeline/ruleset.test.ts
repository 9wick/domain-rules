import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { Track } from "../definition/track.ts";
import { port } from "../port/port.ts";
import { emit } from "./emit.ts";
import { rule } from "./rule.ts";
import { ruleset } from "./ruleset.ts";
import { always } from "./when/step.ts";
import { invocationOf } from "../port/invocation.ts";
import { Context } from "../port/provider.ts";

type S = { readonly n: number };
const track = new Track<"save", "item", S>("save", "item");
const inv = invocationOf(new Context([]), 0);

const positive = rule(track, {
  id: "positive",
  description: "正の数",
  when: always,
  check: ({ n }) => (n > 0 ? Result.succeed({ positive: true }) : Result.fail("NOT_POSITIVE")),
});
const doubled = rule(track, {
  id: "double",
  description: "2倍",
  when: always,
  check: ({ n }) => Result.succeed({ doubled: n * 2 }),
});

test("rule を先頭から順に当て、成功の値を状態に重ねる", async () => {
  expect(await ruleset(positive).add(doubled).run({ n: 2 }, inv)).toEqual(
    Result.succeed({ state: { n: 2, positive: true, doubled: 4 }, events: [] }),
  );
});

test("最初に失敗した rule の名前と失敗の値で止まり、後ろの rule は当てない", async () => {
  let called = false;
  const spy = rule(track, {
    id: "after",
    description: "後ろ",
    when: always,
    check: () => ((called = true), Result.succeed()),
  });
  expect(await ruleset(positive).add(spy).run({ n: -1 }, inv)).toEqual(
    Result.fail({ step: "positive", error: "NOT_POSITIVE" }),
  );
  expect(called).toBe(false);
});

test("when が当たらない rule は check を呼ばず、状態を変えない", async () => {
  let called = false;
  const never = rule(track, {
    id: "never",
    description: "never",
    when: () => false,
    check: () => ((called = true), Result.fail("X")),
  });
  expect(await ruleset(never).add(doubled).run({ n: 1 }, inv)).toEqual(
    Result.succeed({ state: { n: 1, doubled: 2 }, events: [] }),
  );
  expect(called).toBe(false);
});

test("emit のイベントは状態に入れず、当たった emit の分だけ線路の順に溜める", async () => {
  const big = emit(track.assuming<{ readonly doubled: number }>(), {
    id: "big",
    description: "大きい",
    when: (s) => s.doubled > 2,
    event: (s) => ({ type: "BIG", doubled: s.doubled }) as const,
  });
  const seen = emit(track, {
    id: "seen",
    description: "見た",
    when: always,
    event: (s) => ({ type: "SEEN", n: s.n }) as const,
  });
  const rules = ruleset(seen).add(doubled).add(big);
  expect(await rules.run({ n: 2 }, inv)).toEqual(
    Result.succeed({
      state: { n: 2, doubled: 4 },
      events: [
        { type: "SEEN", n: 2 },
        { type: "BIG", doubled: 4 },
      ],
    }),
  );
  expect(await rules.run({ n: 1 }, inv)).toEqual(
    Result.succeed({ state: { n: 1, doubled: 2 }, events: [{ type: "SEEN", n: 1 }] }),
  );
});

test("後ろの rule で失敗すると、前の emit のイベントも返さない", async () => {
  const seen = emit(track, { id: "seen", description: "見た", when: always, event: () => "SEEN" });
  expect(await ruleset(seen).add(positive).run({ n: -1 }, inv)).toEqual(
    Result.fail({ step: "positive", error: "NOT_POSITIVE" }),
  );
});

test("plan と ports は、足した rule の識別子・説明・when の説明・port を順に持つ", () => {
  const find = port("find").of<() => number>();
  const withPort = rule(track, {
    id: "port",
    description: "port",
    requires: { find },
    when: always,
    check: () => Result.succeed(),
  });
  const rs = ruleset(positive).add(withPort);
  expect(rs.plan).toEqual([
    { id: "positive", description: "正の数", when: { kind: "always" }, ports: [] },
    { id: "port", description: "port", when: { kind: "always" }, ports: ["find"] },
  ]);
  expect(rs.ports).toEqual([find]);
});

test("add は元の ruleset を変えず、新しい ruleset を返す", () => {
  const base = ruleset(positive);
  const added = base.add(doubled);
  expect(base.plan.map((r) => r.id)).toEqual(["positive"]);
  expect(added.plan.map((r) => r.id)).toEqual(["positive", "double"]);
});
