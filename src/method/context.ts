import type { Invocation } from "../port/invocation.ts";

// bind が rule の組に渡すもの。メソッドを呼ぶたびに、その呼び出しを作る
export type BindCtx = { readonly invocation: () => Invocation };

export type Args<I, Act> = { readonly input: I; readonly actor: Act };
