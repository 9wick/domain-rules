import type { Actor } from "./model.ts";

export type TrackKind = "save" | "delete" | "decide";

export type WhenDescription =
  | { readonly kind: "always" }
  | { readonly kind: "onCreate" }
  | {
      readonly kind: "changed";
      readonly field: string;
      readonly pre?: Match | undefined;
      readonly next?: Match | undefined;
    }
  | { readonly kind: "next" }
  | { readonly kind: "pre" }
  | { readonly kind: "actor" }
  | { readonly kind: "and" | "or"; readonly conditions: readonly WhenDescription[] }
  | { readonly kind: "not"; readonly condition: WhenDescription }
  | { readonly kind: "custom"; readonly description?: string };

declare const allowedTracks: unique symbol;

// 使える線路を引数の型で持つ。引数は反変なので、使えない線路の rule に渡すと型エラーになる
export type When<K extends TrackKind, Need> = ((s: Need) => boolean) & {
  readonly description: WhenDescription;
  readonly [allowedTracks]?: (k: K) => void;
};

export type WhenParam<K extends TrackKind, S> = ((s: S) => boolean) & {
  readonly description?: WhenDescription;
  readonly [allowedTracks]?: (k: K) => void;
};

// 常に当たる when は description の kind で見分ける。線路は実行時にも同じ kind を見て rule を必ず当てる
export type Always = When<TrackKind, unknown> & { readonly description: { readonly kind: "always" } };
export type IsAlways<W> = W extends { readonly description: { readonly kind: "always" } } ? true : false;
export const isAlways = (w: { readonly description?: WhenDescription }): boolean => w.description?.kind === "always";

export type AnyWhen = ((s: never) => boolean) & {
  readonly description?: WhenDescription;
  readonly [allowedTracks]?: (k: never) => void;
};
type KindsOf<W> = W extends { readonly [allowedTracks]?: (k: infer K) => void }
  ? unknown extends K
    ? TrackKind
    : K & TrackKind
  : TrackKind;
type NeedOf<W> = W extends (s: infer N) => boolean ? N : never;

type CombinedKinds<Ws, K = TrackKind> = Ws extends readonly [infer W, ...infer Rest]
  ? CombinedKinds<Rest, K & KindsOf<W>>
  : K & TrackKind;
export type CombinedNeed<Ws, N = unknown> = Ws extends readonly [infer W, ...infer Rest]
  ? CombinedNeed<Rest, N & NeedOf<W>>
  : N;

// 説明の付いた when を作る。immutable のように、組み合わせの説明を持つ when をライブラリの中で作るときにも使う
export const whenOf = <K extends TrackKind, Need>(
  description: WhenDescription,
  f: (s: Need) => boolean,
): When<K, Need> => Object.freeze(Object.assign((s: Need) => f(s), { description }));

const descriptionOf = (w: AnyWhen): WhenDescription => w.description ?? { kind: "custom" };

export const always: Always = Object.freeze(Object.assign(() => true, { description: { kind: "always" } as const }));

export const onCreate = whenOf<"save", { readonly pre: unknown }>({ kind: "onCreate" }, (s) => s.pre === null);

// undefined は「条件なし」を表すので比べる値に含めない。値は Object.is で比べる
type Match = string | number | bigint | boolean | symbol | null;

type Fields<F extends string> = { readonly [P in F]: unknown };
type Changed<F extends string> = { readonly pre: Fields<F> | null; readonly next: Fields<F> };

const fieldOf = <F extends string>(o: Fields<F>, field: F): unknown => o[field];
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

export const next = <V>(predicate: (v: V) => boolean): When<"save", { readonly next: V }> =>
  whenOf({ kind: "next" }, (s: { readonly next: V }) => predicate(s.next));

export const pre = <V>(predicate: (v: V) => boolean): When<"save" | "delete", { readonly pre: V | null }> =>
  whenOf({ kind: "pre" }, (s: { readonly pre: V | null }) => s.pre !== null && predicate(s.pre));

export const actor = <A = Actor, S = unknown>(
  predicate: (a: A, s: S) => boolean,
): When<TrackKind, { readonly actor: A } & S> =>
  whenOf({ kind: "actor" }, (s: { readonly actor: A } & S) => predicate(s.actor, s));

// 並べた when がどれも、まとめた状態を受け取れることを引数の型で求める。呼び出す側の型で確かめるので、中では型を消さずに呼べる
type Combinable<Ws> = Ws & readonly ((s: CombinedNeed<Ws>) => boolean)[];

export const and = <const Ws extends readonly AnyWhen[]>(
  ...ws: Combinable<Ws>
): When<CombinedKinds<Ws>, CombinedNeed<Ws>> => {
  const tests: readonly ((s: CombinedNeed<Ws>) => boolean)[] = ws;
  return whenOf({ kind: "and", conditions: ws.map(descriptionOf) }, (s: CombinedNeed<Ws>) => tests.every((w) => w(s)));
};

export const or = <const Ws extends readonly AnyWhen[]>(
  ...ws: Combinable<Ws>
): When<CombinedKinds<Ws>, CombinedNeed<Ws>> => {
  const tests: readonly ((s: CombinedNeed<Ws>) => boolean)[] = ws;
  return whenOf({ kind: "or", conditions: ws.map(descriptionOf) }, (s: CombinedNeed<Ws>) => tests.some((w) => w(s)));
};

export const not = <K extends TrackKind, N>(w: When<K, N>): When<K, N> =>
  whenOf({ kind: "not", condition: descriptionOf(w) }, (s: N) => !w(s));

export const describe = <S>(description: string, f: (s: S) => boolean): When<TrackKind, S> =>
  whenOf({ kind: "custom", description }, f);

export const describeWhen = descriptionOf;
