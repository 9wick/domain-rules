import type { Actor } from "./model.ts";

export type TrackKind = "save" | "delete" | "decide";

export type WhenDescription =
  | { readonly kind: "always" }
  | { readonly kind: "onCreate" }
  | { readonly kind: "changed"; readonly field: string; readonly pre?: unknown; readonly next?: unknown }
  | { readonly kind: "next" }
  | { readonly kind: "pre" }
  | { readonly kind: "actor" }
  | { readonly kind: "and" | "or"; readonly conditions: readonly WhenDescription[] }
  | { readonly kind: "not"; readonly condition: WhenDescription }
  | { readonly kind: "custom"; readonly description?: string };

declare const allowedTracks: unique symbol;
declare const alwaysBrand: unique symbol;

// 使える線路を引数の型で持つ。引数は反変なので、使えない線路の rule に渡すと型エラーになる
export type When<K extends TrackKind, Need> = ((s: Need) => boolean) & {
  readonly description: WhenDescription;
  readonly [allowedTracks]?: (k: K) => void;
};

export type WhenParam<K extends TrackKind, S> = ((s: S) => boolean) & {
  readonly description?: WhenDescription;
  readonly [allowedTracks]?: (k: K) => void;
};

export type Always = When<TrackKind, unknown> & { readonly [alwaysBrand]: true };
export type IsAlways<W> = W extends { readonly [alwaysBrand]: true } ? true : false;

type AnyWhen = ((s: never) => boolean) & { readonly [allowedTracks]?: (k: never) => void };
type KindsOf<W> = W extends { readonly [allowedTracks]?: (k: infer K) => void }
  ? unknown extends K
    ? TrackKind
    : K & TrackKind
  : TrackKind;
type NeedOf<W> = W extends (s: infer N) => boolean ? N : never;

type Combine<Ws, K = TrackKind, N = unknown> = Ws extends readonly [infer W, ...infer Rest]
  ? Combine<Rest, K & KindsOf<W>, N & NeedOf<W>>
  : When<K & TrackKind, N>;

const when = <W>(description: WhenDescription, f: (s: any) => boolean): W =>
  Object.freeze(Object.assign((s: unknown) => f(s), { description })) as W;

const descriptionOf = (w: (s: never) => boolean): WhenDescription =>
  (w as { description?: WhenDescription }).description ?? { kind: "custom" };

export const always: Always = when({ kind: "always" }, () => true);

export const onCreate: When<"save", { readonly pre: unknown }> = when({ kind: "onCreate" }, (s) => s.pre === null);

type Match = unknown | ((v: never) => boolean);
const matches = (m: Match, v: unknown) => (typeof m === "function" ? m(v as never) : Object.is(m, v));

export const changed = <const F extends string>(
  field: F,
  values: { readonly pre?: Match; readonly next?: Match } = {},
): When<"save", { readonly pre: { readonly [P in F]: unknown } | null; readonly next: { readonly [P in F]: unknown } }> =>
  when({ kind: "changed", field, ...values }, (s) => {
    if (s.pre === null) return !("pre" in values) && (!("next" in values) || matches(values.next, s.next[field]));
    if (Object.is(s.pre[field], s.next[field])) return false;
    return (!("pre" in values) || matches(values.pre, s.pre[field])) && (!("next" in values) || matches(values.next, s.next[field]));
  });

export const next = <V>(predicate: (v: V) => boolean): When<"save", { readonly next: V }> =>
  when({ kind: "next" }, (s) => predicate(s.next));

export const pre = <V>(predicate: (v: V) => boolean): When<"save" | "delete", { readonly pre: V | null }> =>
  when({ kind: "pre" }, (s) => s.pre !== null && predicate(s.pre));

export const actor = <A = Actor, S = unknown>(predicate: (a: A, s: S) => boolean): When<TrackKind, { readonly actor: A } & S> =>
  when({ kind: "actor" }, (s) => predicate(s.actor, s));

export const and = <const Ws extends readonly AnyWhen[]>(...ws: Ws): Combine<Ws> =>
  when({ kind: "and", conditions: ws.map(descriptionOf) }, (s) => ws.every((w) => w(s as never)));

export const or = <const Ws extends readonly AnyWhen[]>(...ws: Ws): Combine<Ws> =>
  when({ kind: "or", conditions: ws.map(descriptionOf) }, (s) => ws.some((w) => w(s as never)));

export const not = <W extends AnyWhen>(w: W): When<KindsOf<W>, NeedOf<W>> =>
  when({ kind: "not", condition: descriptionOf(w) }, (s) => !w(s as never));

export const describe = <S>(description: string, f: (s: S) => boolean): When<TrackKind, S> =>
  when({ kind: "custom", description }, f);

export const describeWhen = descriptionOf;
