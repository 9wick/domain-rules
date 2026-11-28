// Object.is で比べて、中身が同じなら同じと判定される値。object や配列は別参照なら中身が同じでも別と判定されるので含めない
export type ByValue = string | number | bigint | boolean | symbol | null | undefined;

// 値が ByValue の項目の名前。省略できる項目は undefined を含むので、ここに入る
export type ByValueKeys<T> = { readonly [K in keyof T]-?: T[K] extends ByValue ? K : never }[keyof T] & string;
