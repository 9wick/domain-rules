// 型の上では安全なのに、TypeScript では型 assertion なしに書けない変換だけを置く。あとで別のパッケージに切り出す。
// 置く条件:
// - 外部ライブラリの型安全な API で代わりにできない
// - 変換先の型は引数の型だけで決まり、呼び出す側が選べない
// - 実行時の値が、その型どおりに作られる
import type { PortArgs, PortFns, PortValue, Ports } from "./port.ts";

// requires の port ごとに、同じ key で、その port を呼ぶ関数を置く。各関数の型は call の型が保証する。
// TypeScript は、object を key ごとに組み立てたときに、すべての key が埋まったことを追えないので、組み立てた結果にだけ型を付ける
export const portFns = <P extends Ports>(
  requires: P | undefined,
  call: <K extends keyof P>(p: P[K], args: PortArgs<P[K]>) => Promise<PortValue<P[K]>>,
): PortFns<P> => {
  const fns: Partial<PortFns<P>> = {};
  if (requires !== undefined) {
    for (const key in requires) fns[key] = (...args: PortArgs<P[typeof key]>) => call(requires[key], args);
  }
  return fns as PortFns<P>;
};
