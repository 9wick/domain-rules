import * as Result from "../../shared/result.ts";
import type { TrackKind } from "../../definition/track.ts";

// undefined は「条件なし」を表すので比べる値に含めない。値は Object.is で比べる
export type Match = string | number | bigint | boolean | symbol | null;

export type WhenDescription =
  | { readonly kind: "always" }
  | { readonly kind: "onCreate" }
  | {
      readonly kind: "changed";
      readonly field: string;
      readonly pre?: Match | undefined;
      readonly next?: Match | undefined;
    }
  | { readonly kind: "given"; readonly field: string }
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

export type CombinedKinds<Ws, K = TrackKind> = Ws extends readonly [infer W, ...infer Rest]
  ? CombinedKinds<Rest, K & KindsOf<W>>
  : K & TrackKind;
export type CombinedNeed<Ws, N = unknown> = Ws extends readonly [infer W, ...infer Rest]
  ? CombinedNeed<Rest, N & NeedOf<W>>
  : N;

// 常に当たる when は description の kind で見分ける。線路は実行時にも同じ kind を見て rule を必ず当てる
export type Check<X, V, E> = (s: X) => Promise<Result.Result<V, E>>;

// 常に当たる when は、重ねた状態だけを返す step を持つ。線路はこの step の型から、昇格が必ず起きることを知る
export type Always = When<TrackKind, unknown> & {
  readonly description: { readonly kind: "always" };
  readonly step: <X, V, E>(s: X, check: Check<X, V, E>) => Promise<Result.Result<X & V, E>>;
};
export type IsAlways<W> = W extends { readonly description: { readonly kind: "always" } } ? true : false;

// 説明の付いた when を作る。immutable のように、組み合わせの説明を持つ when をライブラリの中で作るときにも使う
export const whenOf = <K extends TrackKind, Need>(
  description: WhenDescription,
  f: (s: Need) => boolean,
): When<K, Need> => Object.freeze(Object.assign((s: Need) => f(s), { description }));

export const describeWhen = (w: AnyWhen): WhenDescription => w.description ?? { kind: "custom" };
