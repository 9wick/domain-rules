// 型の上の情報と実行時の値をつなぐ変換を、この module だけに集める。
// rule の並びが正しいことは modelRules などの型で確かめ済みで、実行時の線路は型を消した値を扱う。
// そのため、型を消した値を型の付いた値として扱い直す箇所は型 assertion になる。

declare const phantom: unique symbol;

// 実行時には存在せず、型の上だけで情報を運ぶ
export type Phantom<T> = { readonly [phantom]: T };
export type PhantomKey = typeof phantom;

// 型の上の情報は実行時の値から作れないため、ここで付け足す。実行時の部分は引数の型で確かめる
export const withPhantom = <T extends Phantom<unknown>>(runtime: Omit<T, typeof phantom>): T => runtime as T;

// 型の上の情報だけを持ち、中身を外から読めない値を作る。中身は実行時の値が private field などで守る
export const opaque = <T extends Phantom<unknown>>(runtime: object): T => runtime as T;

// 引数の型を消した関数。どんな関数も代入できるが、呼ぶには callErased を通す
export type ErasedFn<R = unknown> = (...args: never) => R;

// 型の上で引数が合うことを確かめ済みの関数を、型を消した値で呼ぶ
export const callErased = <R>(f: ErasedFn<R>, ...args: readonly unknown[]): R =>
  (f as (...a: readonly unknown[]) => R)(...args);

// 実行時に名前ごとに組み立てた object を、組み立て方に対応する型として扱う
export const assembled = <T>(value: Readonly<Record<string, unknown>>): T => value as T;

export type Join<F extends readonly string[]> = F extends readonly [
  infer H extends string,
  ...infer Rest extends readonly string[],
]
  ? Rest extends readonly []
    ? H
    : `${H}, ${Join<Rest>}`
  : string;

// 実行時の join と同じ文字列を、型の上でも組み立てる
export const joinTyped = <const F extends readonly string[]>(fields: F): Join<F> => fields.join(", ") as Join<F>;
