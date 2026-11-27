import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { Track } from "../definition/track.ts";
import { port } from "../port/port.ts";
import { rule } from "./rule.ts";
import { always } from "./when/step.ts";
import { Context } from "../port/provider.ts";
import { invocationOf } from "../port/invocation.ts";

type S = { readonly n: number };
const track = new Track<"save", "item", S>("save", "item");

test("run は状態を check に渡し、check の Result を返す", async () => {
  const positive = rule(track, {
    name: "正の数",
    when: always,
    check: ({ n }) => (n > 0 ? Result.succeed({ checked: true }) : Result.fail("NOT_POSITIVE")),
  });
  const inv = invocationOf(new Context([]), 0);
  expect(await positive.run({ n: 1 }, inv)).toEqual(Result.succeed({ checked: true }));
  expect(await positive.run({ n: -1 }, inv)).toEqual(Result.fail("NOT_POSITIVE"));
});

test("check は requires の port を、1回の呼び出しに束ねた関数で受け取る", async () => {
  const failing = port("failing").of<() => number, "DOWN">();
  const context = new Context([failing.provider(() => Result.fail("DOWN"))]);
  const mapped = rule(track, {
    name: "port を使う",
    requires: { failing },
    when: always,
    check: async (_, { failing }) => {
      const r = await failing();
      return Result.isFailure(r) ? Result.fail({ unavailable: r.error }) : Result.succeed();
    },
  });
  expect(await mapped.run({ n: 1 }, invocationOf(context, 0))).toEqual(Result.fail({ unavailable: "DOWN" }));
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
  await expect(boom.run({ n: 1 }, invocationOf(new Context([]), 0))).rejects.toThrow("bug");
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

test("check の safeTry は、yield* した port の失敗で止まり、その失敗を返す", async () => {
  const failing = port("failing").of<() => number, "DOWN">();
  const double = port("double").of<(n: number) => number>();
  const context = new Context([
    failing.provider(() => Result.fail("DOWN")),
    double.provider((n) => Result.succeed(n * 2)),
  ]);
  const events: string[] = [];
  const stops = rule(track, {
    name: "失敗で止まる",
    requires: { failing, double },
    when: always,
    check: (_, __, { safeTry }) =>
      safeTry(async function* ({ failing, double }) {
        const d = yield* double(1);
        events.push(`double ${d}`);
        yield* failing();
        events.push("unreachable");
        return Result.succeed();
      }),
  });
  expect(await stops.run({ n: 1 }, invocationOf(context, 0))).toEqual(Result.fail("DOWN"));
  expect(events).toEqual(["double 2"]);
});

test("check の safeTry は、最後まで進んだら body が返した Result を返す", async () => {
  const double = port("double").of<(n: number) => number>();
  const context = new Context([double.provider((n) => Result.succeed(n * 2))]);
  const r = rule(track, {
    name: "最後まで進む",
    requires: { double },
    when: ({ n }: S) => n !== 0,
    check: ({ n }, _, { safeTry }) =>
      safeTry(async function* ({ double }) {
        const d = yield* double(n);
        return d > 2 ? Result.succeed({ doubled: d }) : Result.fail("SMALL");
      }),
  });
  expect(await r.run({ n: 2 }, invocationOf(context, 0))).toEqual(Result.succeed({ doubled: 4 }));
  expect(await r.run({ n: 1 }, invocationOf(context, 0))).toEqual(Result.fail("SMALL"));
});
