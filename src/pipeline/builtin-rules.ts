import { Result } from "@praha/byethrow";
import type { Track, TrackKind } from "../definition/track.ts";
import type { NoPorts } from "../port/port.ts";
import { rule, type Rule } from "./rule.ts";
import { changed, onCreate } from "./when/builders.ts";
import { always } from "./when/step.ts";
import { describeWhen, whenOf, type Always } from "./when/when.ts";

const valueOf = (o: object | null, f: string): unknown => (o === null ? undefined : new Map(Object.entries(o)).get(f));

export const immutable = <T extends string, S extends { readonly pre: object | null; readonly next: object }>(
  track: Track<"save", T, S>,
  fields: readonly (keyof S["next"] & string)[],
) => {
  const changedField = (s: S) => fields.find((f) => !Object.is(valueOf(s.pre, f), valueOf(s.next, f)));
  return rule(track, {
    name: `作成後に変えられない項目: ${fields.join(", ")}` as const,
    // 説明は and(not(onCreate), or(changed(...))) と同じ形にする。判定は項目の数によらず1つの関数で書く
    when: whenOf<"save", S>(
      {
        kind: "and",
        conditions: [
          { kind: "not", condition: describeWhen(onCreate) },
          { kind: "or", conditions: fields.map((f) => describeWhen(changed(f))) },
        ],
      },
      (s) => s.pre !== null && changedField(s) !== undefined,
    ),
    check: (s) => {
      const field = changedField(s);
      return field === undefined ? Result.succeed() : Result.fail({ code: "IMMUTABLE_FIELD_CHANGED" as const, field });
    },
  });
};

// 何も確かめずに通す rule。条件なしで削除してよい model の delete に ruleset(alwaysAllow) として渡す
export const alwaysAllow: Rule<TrackKind, string, "常に許可", unknown, Always, void, never, NoPorts> = Object.freeze({
  kind: "rule",
  name: "常に許可",
  ports: [],
  when: always,
  run: async () => Result.succeed(),
});
