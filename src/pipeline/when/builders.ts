import type { TrackKind } from "../../definition/track.ts";
import type { ByValue } from "../../shared/by-value.ts";
import {
  describeWhen,
  whenOf,
  type AnyWhen,
  type CombinedKinds,
  type CombinedNeed,
  type Match,
  type When,
} from "./when.ts";

export const onCreate = whenOf<"save", { readonly pre: unknown }>({ kind: "onCreate" }, (s) => s.pre === null);

type Fields<F extends string> = { readonly [P in F]: unknown };
// 変化は Object.is で判定するので、比べる項目は値で比べられるものに限る。配列や object の項目は別参照なら中身が同じでも変化と判定されるので、型エラーにする
type ComparedFields<F extends string> = { readonly [P in F]: ByValue };
type Changed<F extends string> = { readonly pre: ComparedFields<F> | null; readonly next: ComparedFields<F> };

const fieldOf = <F extends string>(o: ComparedFields<F>, field: F): ByValue => o[field];
const matches = (m: Match | undefined, v: unknown) => m === undefined || Object.is(m, v);

export const changed = <const F extends string>(
  field: F,
  values: { readonly pre?: Match | undefined; readonly next?: Match | undefined } = {},
): When<"save", Changed<F>> =>
  whenOf({ kind: "changed", field, ...values }, (s: Changed<F>) => {
    const after = fieldOf(s.next, field);
    if (s.pre === null) return values.pre === undefined && matches(values.next, after);
    const before = fieldOf(s.pre, field);
    return !Object.is(before, after) && matches(values.pre, before) && matches(values.next, after);
  });

// 値が変わったかではなく、呼び出し時にその項目を指定したかを見る。null を指定したときも当たる。
// input は項目がすべて省略可能で項目名を確かめられないので、保存なら next、削除なら pre に項目があることを求めて、model にない項目名を型エラーにする
type Given<F extends string> = { readonly input: object } & (
  | { readonly next: Fields<F> }
  | { readonly pre: Fields<F> }
);
export const given = <const F extends string>(field: F): When<"save" | "delete", Given<F>> =>
  whenOf({ kind: "given", field }, (s: Given<F>) => Object.hasOwn(s.input, field));

export const next = <V>(predicate: (v: V) => boolean): When<"save", { readonly next: V }> =>
  whenOf({ kind: "next" }, (s: { readonly next: V }) => predicate(s.next));

export const pre = <V>(predicate: (v: V) => boolean): When<"save" | "delete", { readonly pre: V | null }> =>
  whenOf({ kind: "pre" }, (s: { readonly pre: V | null }) => s.pre !== null && predicate(s.pre));

// actor の型は述語の引数から決まる
export const actor = <A, S = unknown>(predicate: (a: A, s: S) => boolean): When<TrackKind, { readonly actor: A } & S> =>
  whenOf({ kind: "actor" }, (s: { readonly actor: A } & S) => predicate(s.actor, s));

// 並べた when がどれも、まとめた状態を受け取れることを引数の型で求める。呼び出す側の型で確かめるので、中では型を消さずに呼べる
type Combinable<Ws> = Ws & readonly ((s: CombinedNeed<Ws>) => boolean)[];

export const and = <const Ws extends readonly AnyWhen[]>(
  ...ws: Combinable<Ws>
): When<CombinedKinds<Ws>, CombinedNeed<Ws>> => {
  const tests: readonly ((s: CombinedNeed<Ws>) => boolean)[] = ws;
  return whenOf({ kind: "and", conditions: ws.map(describeWhen) }, (s: CombinedNeed<Ws>) => tests.every((w) => w(s)));
};

export const or = <const Ws extends readonly AnyWhen[]>(
  ...ws: Combinable<Ws>
): When<CombinedKinds<Ws>, CombinedNeed<Ws>> => {
  const tests: readonly ((s: CombinedNeed<Ws>) => boolean)[] = ws;
  return whenOf({ kind: "or", conditions: ws.map(describeWhen) }, (s: CombinedNeed<Ws>) => tests.some((w) => w(s)));
};

export const not = <K extends TrackKind, N>(w: When<K, N>): When<K, N> =>
  whenOf({ kind: "not", condition: describeWhen(w) }, (s: N) => !w(s));

export const describe = <S>(description: string, f: (s: S) => boolean): When<TrackKind, S> =>
  whenOf({ kind: "custom", description }, f);
