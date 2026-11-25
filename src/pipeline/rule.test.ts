import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { Track } from "../definition/track.ts";
import { port } from "../port/port.ts";
import { rule } from "./rule.ts";
import { always } from "./when/step.ts";

type S = { readonly n: number };
const track = new Track<"save", "item", S>("save", "item");

test("run は状態を check に渡し、check の Result を返す", async () => {
  const positive = rule(track, {
    name: "正の数",
    when: always,
    check: ({ n }) => (n > 0 ? Result.succeed({ checked: true }) : Result.fail("NOT_POSITIVE")),
  });
  const inv = { scope: {}, now: 0 };
  expect(await positive.run({ n: 1 }, inv)).toEqual(Result.succeed({ checked: true }));
  expect(await positive.run({ n: -1 }, inv)).toEqual(Result.fail("NOT_POSITIVE"));
});

test("check は requires の port を、1回の呼び出しに束ねた関数で受け取る", async () => {
  const failing = port("failing").of<() => number, "DOWN">();
  const scope = {};
  failing.provider(() => Result.fail("DOWN")).registerIn(scope);
  const mapped = rule(track, {
    name: "port を使う",
    requires: { failing },
    when: always,
    check: async (_, { failing }) => {
      const r = await failing();
      return Result.isFailure(r) ? Result.fail({ unavailable: r.error }) : Result.succeed();
    },
  });
  expect(await mapped.run({ n: 1 }, { scope, now: 0 })).toEqual(Result.fail({ unavailable: "DOWN" }));
  expect(mapped.ports).toEqual([failing]);
});

test("check が throw した例外は握りつぶさない", async () => {
  const boom = rule(track, {
    name: "boom",
    when: always,
    check: (): Result.Result<void, never> => {
      throw new Error("bug");
    },
  });
  await expect(boom.run({ n: 1 }, { scope: {}, now: 0 })).rejects.toThrow("bug");
});

test("when は判定と説明を保ち、当たらなければ状態を進めない step を持つ", async () => {
  const onlyPositive = rule(track, {
    name: "正のときだけ",
    when: ({ n }: S) => n > 0,
    check: () => Result.succeed({ checked: true }),
  });
  expect([onlyPositive.when({ n: 1 }), onlyPositive.when({ n: -1 })]).toEqual([true, false]);
  expect(await onlyPositive.when.step({ n: -1 }, async () => Result.succeed({ checked: true }))).toEqual(
    Result.succeed({ n: -1 }),
  );
  expect(Object.isFrozen(onlyPositive)).toBe(true);
});
