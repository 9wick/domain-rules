import * as Result from "../shared/result.ts";
import type { Track, TrackKind } from "../definition/track.ts";
import type { NoPorts } from "../port/port.ts";
import { rule, type Rule } from "./rule.ts";
import { changed, onCreate } from "./when/builders.ts";
import { always } from "./when/step.ts";
import { describeWhen, whenOf, type Always } from "./when/when.ts";

const valueOf = (o: object | null, f: string): unknown => (o === null ? undefined : new Map(Object.entries(o)).get(f));

type SaveTrackState = { readonly pre: object | null; readonly next: object };

const immutableRule = <T extends string, S extends SaveTrackState, const I extends string>(
  track: Track<"save", T, S>,
  fields: readonly (keyof S["next"] & string)[],
  id: I,
) => {
  const changedField = (s: S) => fields.find((f) => !Object.is(valueOf(s.pre, f), valueOf(s.next, f)));
  return rule(track, {
    id,
    description: `作成後に変えられない項目: ${fields.join(", ")}`,
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

// id は既定で "immutable"。同じ線路に複数置いて失敗の step でも区別したいときだけ、id を渡して変える
export function immutable<T extends string, S extends SaveTrackState>(
  track: Track<"save", T, S>,
  fields: readonly (keyof S["next"] & string)[],
): ReturnType<typeof immutableRule<T, S, "immutable">>;
export function immutable<T extends string, S extends SaveTrackState, const I extends string>(
  track: Track<"save", T, S>,
  fields: readonly (keyof S["next"] & string)[],
  options: { readonly id: I },
): ReturnType<typeof immutableRule<T, S, I>>;
export function immutable<T extends string, S extends SaveTrackState>(
  track: Track<"save", T, S>,
  fields: readonly (keyof S["next"] & string)[],
  options: { readonly id: string } = { id: "immutable" },
) {
  return immutableRule(track, fields, options.id);
}

// 何も確かめずに通す rule。条件なしで削除してよい model の delete に ruleset(alwaysAllow) として渡す
export const alwaysAllow: Rule<TrackKind, string, "alwaysAllow", unknown, Always, void, never, NoPorts> = Object.freeze(
  {
    kind: "rule",
    id: "alwaysAllow",
    description: "常に許可",
    ports: [],
    when: always,
    run: async () => Result.succeed(),
  },
);
