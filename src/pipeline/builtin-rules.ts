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

type NextOf<S> = S extends { readonly next: infer X } ? X : never;
type PreOf<S> = S extends { readonly pre: infer X } ? Exclude<X, null> : never;
type Filled<S, F extends keyof NextOf<S>> = Exclude<NextOf<S>[F], undefined>;

// 既定値を書ける項目。value で省略できて、永続化の型では必ずある項目に限る。
// 更新では既存の値がその項目を必ず持つので、作成時だけ値を入れても、後ろの rule は値がある型で受け取れる
type Defaultable<S, Key extends string> = {
  [F in keyof NextOf<S>]-?: F extends Key
    ? never
    : {} extends Pick<NextOf<S>, F>
      ? F extends keyof PreOf<S>
        ? {} extends Pick<PreOf<S>, F>
          ? never
          : [PreOf<S>[F]] extends [Filled<S, F>]
            ? F
            : never
        : never
      : never;
}[keyof NextOf<S>] &
  string;

// 項目の型が関数だと、既定値そのものか値を作る関数かを見分けられない。domain の値は関数を持たない前提にする
type DefaultOf<S, F extends keyof NextOf<S>> = Filled<S, F> | ((s: S) => Filled<S, F>);
type DefaultSpec<S, Key extends string> = { readonly [F in Defaultable<S, Key>]?: DefaultOf<S, F> };
type OnlyDefaultable<D, S, Key extends string> = [Exclude<keyof D, Defaultable<S, Key>>] extends [never]
  ? unknown
  : {
      readonly "既定値を書けるのは、value で省略できて永続化の型では必ずある項目だけ": Exclude<
        keyof D,
        Defaultable<S, Key>
      >;
    };

type Defaulted<S, D> = {
  readonly next: { readonly [F in keyof D]: F extends keyof NextOf<S> ? Filled<S, F> : never };
};

type DefaultValue<S> =
  | ((s: S) => unknown)
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | readonly unknown[]
  | { readonly [k: string]: unknown };

const defaultFieldsRule = <T extends string, S extends SaveTrackState, const I extends string>(
  track: Track<"save", T, S>,
  spec: Readonly<Record<string, DefaultValue<S>>>,
  id: I,
) => {
  const fields = Object.keys(spec);
  const filled = (s: S) =>
    Object.fromEntries(
      Object.entries(spec)
        .filter(([f]) => valueOf(s.next, f) === undefined)
        .map(([f, d]) => [f, typeof d === "function" ? d(s) : d]),
    );
  return rule(track, {
    id,
    description: `作成時に省略したときの既定値: ${fields.join(", ")}`,
    // 後ろの rule が値のある型で受け取れるよう、昇格は必ず起きる always にする。値を入れるのは作成時だけ
    when: always,
    check: (s) => (s.pre === null ? Result.succeed({ next: filled(s) }) : Result.succeed()),
  });
};

// 作成時に省略した項目へ既定値を入れる。更新では既存の値を引き継ぐので何もしない。
// 実装は項目名を string で扱うので、項目ごとの型は宣言の側で約束する。
// 作成時は省略した項目に spec の値が入り、更新時は既存の値が永続化の型どおりに項目を持つことを Defaultable で確かめている
export function defaultFields<
  T extends string,
  S extends SaveTrackState,
  Key extends string,
  const D extends DefaultSpec<S, Key>,
>(
  track: Track<"save", T, S, Key>,
  spec: D & OnlyDefaultable<D, S, Key>,
): Rule<"save", T, "defaultFields", S, Always, Defaulted<S, D>, never, NoPorts>;
export function defaultFields<
  T extends string,
  S extends SaveTrackState,
  Key extends string,
  const D extends DefaultSpec<S, Key>,
  const I extends string,
>(
  track: Track<"save", T, S, Key>,
  spec: D & OnlyDefaultable<D, S, Key>,
  options: { readonly id: I },
): Rule<"save", T, I, S, Always, Defaulted<S, D>, never, NoPorts>;
export function defaultFields<T extends string, S extends SaveTrackState>(
  track: Track<"save", T, S>,
  spec: Readonly<Record<string, DefaultValue<S>>>,
  options: { readonly id: string } = { id: "defaultFields" },
) {
  return defaultFieldsRule(track, spec, options.id);
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
