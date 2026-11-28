import * as Result from "../shared/result.ts";
import { Panic } from "../shared/panic.ts";
import type { Invocation } from "./invocation.ts";
import type { Context, Provider } from "./provider.ts";
import { Brand, Slot } from "./slot.ts";

declare const portTypes: unique symbol;

type ImplOf<A extends readonly unknown[], T, E> = (...args: A) => Result.Result<T, E> | Result.ResultAsync<T, E>;
// 引数を1つずつ Map で引く木。文字列に直さず値そのもので比べるので、undefined と null、Map の中身の違いを取り違えず、BigInt も扱える
type Memo<T, E> = { readonly children: Map<unknown, Memo<T, E>>; result: Promise<Result.Result<T, E>> | undefined };

const emptyMemo = <T, E>(): Memo<T, E> => ({ children: new Map(), result: undefined });

const memoAt = <T, E>(root: Memo<T, E>, args: readonly unknown[]): Memo<T, E> =>
  args.reduce<Memo<T, E>>((node, arg) => {
    const found = node.children.get(arg);
    if (found !== undefined) return found;
    const child = emptyMemo<T, E>();
    node.children.set(arg, child);
    return child;
  }, root);

// Map は object を同一性で比べ、中身が同じ別の object では結果を使い回せない。気づかないまま毎回呼ばないよう、cached の引数は値で比べられるものに限る
export type CacheableArg = string | number | bigint | boolean | symbol | null | undefined;

// port の差し込み口と、cached のときに結果を使い回す memo の封。cached で作った port も同じものを使うので、元の宣言の provider で満たせる
type Declared<N extends string, A extends readonly unknown[], T, E> = {
  readonly slot: Slot<N, ImplOf<A, T, E>>;
  readonly memo: Brand<Memo<T, E>>;
};

// port は宣言で、実装は provider であとから渡す。port 自身は状態を持たず、実装は bind の Context、memo は1回の呼び出しが持つ。
// 型引数は不変にする。広い型の port として扱えると、宣言と違う型の実装を登録できてしまうため
export class Port<N extends string, in out A extends readonly unknown[], in out T, in out E> {
  declare readonly [portTypes]: { readonly args: A; readonly value: T; readonly error: E };
  readonly kind = "port";
  readonly name: N;
  readonly cached: boolean;
  readonly #declared: Declared<N, A, T, E>;

  constructor(name: N, cached: boolean, declared: Declared<N, A, T, E>) {
    this.name = name;
    this.cached = cached;
    this.#declared = declared;
    Object.freeze(this);
  }

  // method ではなく関数の property にするのは、method の引数は広い型の object の型へ代入するときに
  // 確かめられず、宣言と違う型の実装を渡せてしまうため
  readonly provider = (impl: ImplOf<A, T, E>): Provider<N> => this.#declared.slot.provider(impl);

  readonly valued = (v: T): Provider<N> => this.provider(() => Result.succeed(v));

  readonly providedIn = (context: Context): boolean => this.#declared.slot.providedIn(context);

  readonly withCache = (): Port<N, A, T, E> => new Port(this.name, true, this.#declared);

  readonly callIn = async (invocation: Invocation, args: A): Promise<Result.Result<T, E>> => {
    const impl = this.#declared.slot.implIn(invocation.context);
    // bind が provider の不足を確かめてから呼ぶので、ここに来るのは壊れたときだけ
    if (impl === undefined) throw new Panic(`no provider for port "${this.name}"`);
    if (!this.cached) return impl(...args);
    // 同じ引数の呼び出しを1回の呼び出しの中で使い回す
    const node = memoAt(this.#memoIn(invocation), args);
    if (node.result !== undefined) return node.result;
    const pending = Promise.resolve(impl(...args));
    node.result = pending;
    return pending;
  };

  #memoIn(invocation: Invocation): Memo<T, E> {
    const { slot, memo: brand } = this.#declared;
    const boxed = invocation.memos.get(slot);
    const found = boxed === undefined ? undefined : brand.open(boxed);
    if (found !== undefined) return found;
    const memo = emptyMemo<T, E>();
    invocation.memos.set(slot, brand.box(memo));
    return memo;
  }

  // check に渡す関数。provider と同じ Result を返し、失敗をどう扱うかは check が決める
  readonly resolveIn =
    (invocation: Invocation) =>
    (...args: A): Promise<Result.Result<T, E>> =>
      this.callIn(invocation, args);

  // safeTry の中で yield* に渡す関数。失敗なら yield して safeTry に止めさせ、成功なら値を返す
  readonly unwrapIn = (invocation: Invocation) => {
    const call = (args: A) => this.callIn(invocation, args);
    const name = this.name;
    return async function* (...args: A): AsyncGenerator<Result.Failure<E>, T> {
      const r = await call(args);
      if (r.type === "Failure") {
        yield r;
        // safeTry は失敗を受け取ったら generator を再開しないので、ここに来るのは壊れたときだけ
        throw new Panic(`port "${name}" was resumed after yielding a failure`);
      }
      return r.value;
    };
  };
}

// 型引数を問わない port。型の上で port の一覧を持つためで、実装の登録や呼び出しには使えない
export type AnyPort = {
  readonly kind: "port";
  readonly name: string;
  readonly cached: boolean;
  readonly providedIn: (context: Context) => boolean;
};

type TypesOf<P> = P extends { readonly [portTypes]: infer X } ? X : never;
export type PortArgs<P> = TypesOf<P> extends { readonly args: infer A extends readonly unknown[] } ? A : never;
export type PortValue<P> = TypesOf<P> extends { readonly value: infer T } ? T : never;
export type PortError<P> = TypesOf<P> extends { readonly error: infer E } ? E : never;

export type Ports = Readonly<Record<string, AnyPort>>;
export type NoPorts = Readonly<Record<never, AnyPort>>;
export type PortNames<P extends Ports> = { [K in keyof P]: P[K]["name"] }[keyof P];

export const port = <const N extends string>(name: N) => ({
  of: <F extends (...args: never) => unknown, E = never>() =>
    new Port<N, Parameters<F>, ReturnType<F>, E>(name, false, { slot: new Slot(name), memo: new Brand() }),
});

export const cached = <N extends string, A extends readonly CacheableArg[], T, E>(
  p: Port<N, A, T, E>,
): Port<N, A, T, E> => p.withCache();
