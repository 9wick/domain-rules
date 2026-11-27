import type { Context } from "./provider.ts";

// 1回のメソッド呼び出し。context は bind ごとに1つで、memos はこの呼び出しの中でだけ cached の port が結果を使い回す置き場
export type Invocation = {
  readonly context: Context;
  readonly now: number;
  readonly memos: Map<object, object>;
};

export const invocationOf = (context: Context, now: number): Invocation => ({ context, now, memos: new Map() });
