import type * as Result from "../shared/result.ts";

// 失敗を yield した時点で止め、その失敗を返す。最後まで進んだら body が return した Result を返す。
// 返り値を Result の和集合のままにして、成功の値と失敗の型は rule が引く
export type SafeTry<U> = <Y extends Result.Failure<unknown>, R extends Result.Result<unknown, unknown>>(
  body: (unwrapped: U) => AsyncIterator<Y, R>,
) => Promise<Y | R>;

export const safeTryWith =
  <U>(unwrapped: U): SafeTry<U> =>
  async (body) => {
    const it = body(unwrapped);
    const step = await it.next();
    if (step.done === true) return step.value;
    // 失敗で止めた generator を閉じて、利用者の finally や using の後始末を走らせる
    await it.return?.();
    return step.value;
  };
