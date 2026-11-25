import { Result } from "@praha/byethrow";
import type { Always, Check } from "./when.ts";

// 成功の値を状態に重ねる。next は項目ごとに重ねる。
// 重ねた値の型は、状態の型と成功の値の型の交差型になる。成功の値が状態の項目を狭める型であることは、線路の add が確かめる
const objectOf = (value: unknown): object | undefined =>
  typeof value === "object" && value !== null ? value : undefined;
const nextOf = (value: unknown): object | undefined => {
  const o = objectOf(value);
  return o === undefined ? undefined : objectOf(new Map(Object.entries(o)).get("next"));
};
const nestedNext = (s: unknown, v: unknown): object => {
  const before = nextOf(s);
  const added = nextOf(v);
  return before !== undefined && added !== undefined ? { next: { ...before, ...added } } : {};
};
const merged = <X, V>(s: X, v: V): X & V => Object.assign({}, s, v, nestedNext(s, v));

// 当たる rule の check を呼び、成功の値を重ねる
const applied = async <X, V, E>(s: X, check: Check<X, V, E>): Promise<Result.Result<X & V, E>> => {
  const r = await check(s);
  return Result.isFailure(r) ? r : Result.succeed(merged(s, r.value));
};

// 当たらないこともある when の step。当たらなければ状態をそのまま返す
export type ConditionalStep<Need> = <X extends Need, V, E>(
  s: X,
  check: Check<X, V, E>,
) => Promise<Result.Result<X | (X & V), E>>;
export const conditionalStep =
  <Need>(test: (s: Need) => boolean): ConditionalStep<Need> =>
  async (s, check) =>
    test(s) ? applied(s, check) : Result.succeed(s);

export const always: Always = Object.freeze(
  Object.assign(() => true, { description: { kind: "always" } as const, step: applied }),
);
