import { mapValues } from "as-free";
import type { Invocation } from "../port/invocation.ts";
import type { AnyPort } from "../port/port.ts";
import { safeTryWith, type SafeTry } from "./safe-try.ts";

// requires に書ける record。各 port が、1回の呼び出しから check に渡す関数を作れることを型で表す
export type Requires = Readonly<
  Record<
    string,
    AnyPort & {
      readonly resolveIn: (invocation: Invocation) => unknown;
      readonly unwrapIn: (invocation: Invocation) => unknown;
    }
  >
>;

type HasIndex<P> = string extends keyof P
  ? true
  : number extends keyof P
    ? true
    : symbol extends keyof P
      ? true
      : false;
type OptionalKeys<P> = { [K in keyof P]-?: {} extends Pick<P, K> ? K : never }[keyof P];

// index signature や省略できる key があると、bind が確かめる port と check が使う port がずれる
export type StrictRecord<P> =
  HasIndex<P> extends true
    ? { readonly "index signature の record は渡せない": never }
    : [OptionalKeys<P>] extends [never]
      ? unknown
      : { readonly "省略できる key は渡せない": OptionalKeys<P> };

// requires の port ごとに、check に渡す関数を作る
export const resolvePorts = <P extends Requires>(requires: P, invocation: Invocation) =>
  mapValues(requires, (p) => p.resolveIn(invocation));
export type PortFns<P extends Requires> = ReturnType<typeof resolvePorts<P>>;

// requires の port ごとに、safeTry の中で yield* に渡す関数を作る
export const unwrapPorts = <P extends Requires>(requires: P, invocation: Invocation) =>
  mapValues(requires, (p) => p.unwrapIn(invocation));
export type UnwrappedPortFns<P extends Requires> = ReturnType<typeof unwrapPorts<P>>;

// check と load の fetch の第3引数。port の Result を if で取り出す代わりに、yield* で取り出して書くための道具
export type CheckTools<P extends Requires> = { readonly safeTry: SafeTry<UnwrappedPortFns<P>> };

// check と load の fetch は、どちらも requires の port から1回の呼び出しごとに作った関数を受け取る
export const withPorts =
  <P extends Requires, X, R>(requires: P, step: (x: X, ports: PortFns<P>, tools: CheckTools<P>) => R) =>
  (x: X, invocation: Invocation): R =>
    step(x, resolvePorts(requires, invocation), { safeTry: safeTryWith(unwrapPorts(requires, invocation)) });
