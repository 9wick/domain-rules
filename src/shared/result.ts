// byethrow の Result と同じ形のデータを自前で定義する。利用者が byethrow で作った値も構造的に同じ型として通るので、
// byethrow のバージョンを peer dependency で固定せずに済む
export type Success<T> = { readonly type: "Success"; readonly value: T };
export type Failure<E> = { readonly type: "Failure"; readonly error: E };
export type Result<T, E> = Success<T> | Failure<E>;
export type ResultAsync<T, E> = Promise<Result<T, E>>;

export function succeed(): Success<void>;
export function succeed<T>(value: T): Success<T>;
export function succeed<T>(...args: [] | [T]): Success<T | undefined> {
  return { type: "Success", value: args[0] };
}

export const fail = <E>(error: E): Failure<E> => ({ type: "Failure", error });
