// 型の上では正しいのに、TypeScript では型 assertion なしに書けない変換だけを置く。あとで別のパッケージに切り出す。
// 置く条件:
// - 外部ライブラリの型安全な API で代わりにできない
// - 変換先の型は引数の型だけで決まり、呼び出す側が選べない
// - 公開する型が受け付けるどの入力に対しても、返す値がその型どおりになることを示せる
//
// TypeScript には「型から型を作る関数」を型引数に渡す仕組みがないので、key ごとに型の違う値を写した object に型を付けられない。
// ここでは各要素が resolveIn で自分の写し先の型を持つ形にして、写し方を型引数で渡さずに済ませる。

type Resolver<C> = { readonly resolveIn: (ctx: C) => unknown };
type Out<X> = X extends { readonly resolveIn: (ctx: never) => infer R } ? R : never;

type HasIndex<P> = string extends keyof P
  ? true
  : number extends keyof P
    ? true
    : symbol extends keyof P
      ? true
      : false;
type OptionalKeys<P> = { [K in keyof P]-?: {} extends Pick<P, K> ? K : never }[keyof P];

// index signature や省略できる key があると、型にある key が値にないことがある
export type StrictRecord<P> =
  HasIndex<P> extends true
    ? { readonly "index signature の record は渡せない": never }
    : [OptionalKeys<P>] extends [never]
      ? unknown
      : { readonly "省略できる key は渡せない": OptionalKeys<P> };

export type Resolved<P> = { readonly [K in keyof P]: Out<P[K]> };

// holder の field に置いた record を写す。field を省略できるのは、record の型に key がないときだけ。
// そのため field が省略されていれば、写した結果の型にも key がなく、空の object で型どおりになる
export type Holder<F extends string, P> = { readonly [_ in F]?: P & StrictRecord<P> } & ([keyof P] extends [never]
  ? unknown
  : { readonly [_ in F]: P & StrictRecord<P> });

// record の key K を引くと、record[K].resolveIn(ctx) を返す。
// 列挙して object を作ると、列挙できない key や継承した key が型にはあるのに値にない、ということが起きる。
// key で引かれたときに record[K] を引けば、型にある key は必ず引けるので、値が欠けない
export const resolveField = <C, F extends string, const P extends Readonly<Record<string, Resolver<C>>>>(
  holder: Holder<F, P>,
  field: F,
  ctx: C,
): Resolved<P> => {
  const optional: { readonly [_ in F]?: P & StrictRecord<P> } = holder;
  const record = optional[field];
  const memo = new Map<string, unknown>();
  return new Proxy(
    {},
    {
      get: (_, k) => {
        if (typeof k !== "string" || record === undefined) return undefined;
        if (memo.has(k)) return memo.get(k);
        const r: Resolver<C> | undefined = record[k];
        if (r === undefined) return undefined;
        const v = r.resolveIn(ctx);
        memo.set(k, v);
        return v;
      },
    },
  ) as Resolved<P>;
};
