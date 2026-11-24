// 型の上では正しいのに、TypeScript では型 assertion なしに書けない変換だけを置くパッケージ。
// 置く条件:
// - 外部ライブラリの型安全な API で代わりにできない
// - 変換先の型は引数の型だけで決まり、呼び出す側が選べない
// - TypeScript 自身が置いている前提(値は型どおり、列挙すれば型の key が出てくる)だけから、返す値が型どおりになることを示せる
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

// record の列挙できる own の key ごとに、record[K].resolveIn(ctx) を置く。
// TypeScript は spread の型を「元の型の key をすべて持つ」とするので、列挙すれば型の key が出てくることを前提にしている。
// ここが置く前提もそれと同じで、それ以上は置かない
export const resolveField = <C, F extends string, const P extends Readonly<Record<string, Resolver<C>>>>(
  holder: Holder<F, P>,
  field: F,
  ctx: C,
): Resolved<P> => {
  const optional: { readonly [_ in F]?: P & StrictRecord<P> } = holder;
  const record: Readonly<Record<string, Resolver<C>>> = optional[field] ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, r] of Object.entries(record)) out[k] = r.resolveIn(ctx);
  return Object.freeze(out) as Resolved<P>;
};
type Named<C> = Resolver<C> & { readonly name: string };

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
type DuplicateName<T extends readonly { readonly name: string }[], Seen = never> = T extends readonly [
  infer H extends { readonly name: string },
  ...infer R extends readonly { readonly name: string }[],
]
  ? H["name"] extends Seen
    ? H["name"]
    : DuplicateName<R, Seen | H["name"]>
  : never;
type NonLiteralName<T extends readonly { readonly name: string }[]> = {
  [I in keyof T]: string extends T[I]["name"] ? T[I] : true extends IsUnion<T[I]["name"]> ? T[I] : never;
}[number];

// 型の key が、要素の name と1対1になるときだけ受け付ける。
// 長さの決まらない配列は要素が無いことがあり、name が string や和の型だと、型の key が値に無いことがある
export type UniqueNames<T extends readonly { readonly name: string }[]> = number extends T["length"]
  ? { readonly "長さの決まった tuple を渡す": never }
  : [NonLiteralName<T>] extends [never]
    ? [DuplicateName<T>] extends [never]
      ? unknown
      : { readonly "name が重複している": DuplicateName<T> }
    : { readonly "name は1つの文字列リテラルにする": NonLiteralName<T> };

export type ByName<T extends readonly { readonly name: string }[]> = {
  readonly [E in T[number] as E["name"]]: Out<E>;
};

// tuple の要素ごとに、要素の name に resolveIn(ctx) を置く。
// UniqueNames で、型の key は要素の name と1対1になっている。重複は実行時にも確かめる
export const byName = <C, const T extends readonly Named<C>[]>(items: T & UniqueNames<T>, ctx: C): ByName<T> => {
  const out: Record<string, unknown> = {};
  for (const item of items) {
    if (Object.hasOwn(out, item.name)) throw new Error(`"${item.name}" が重複しています`);
    out[item.name] = item.resolveIn(ctx);
  }
  return Object.freeze(out) as ByName<T>;
};
