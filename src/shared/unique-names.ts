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

// 結果の key が、要素の name と1対1になるときだけ受け付ける
export type UniqueNames<T extends readonly { readonly name: string }[]> = number extends T["length"]
  ? { readonly "長さの決まった tuple を渡す": never }
  : [NonLiteralName<T>] extends [never]
    ? [DuplicateName<T>] extends [never]
      ? unknown
      : { readonly "name が重複している": DuplicateName<T> }
    : { readonly "name は1つの文字列リテラルにする": NonLiteralName<T> };
