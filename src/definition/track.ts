export type TrackKind = "save" | "delete" | "decide";

declare const trackState: unique symbol;
declare const trackKeys: unique symbol;

// rule をどの線路に置くかと、その線路で rule が受け取る状態の型を表す。
// Key は next のうち key の項目名。線路の next は key と value を合わせた型なので、value の項目だけを扱う rule が key を見分けるために持つ
export class Track<K extends TrackKind, T extends string, S, Key extends string = never> {
  declare readonly [trackState]: S;
  // 引数の位置に置いて、key を知らない線路の型 (Key = never) へも代入できるようにする
  declare readonly [trackKeys]: (key: Key) => void;
  readonly kind: K;
  readonly target: T;

  constructor(kind: K, target: T) {
    this.kind = kind;
    this.target = target;
    Object.freeze(this);
  }

  // 前の rule が昇格させた状態を前提にする
  assuming<R>(): Track<K, T, S & R, Key> {
    return new Track<K, T, S & R, Key>(this.kind, this.target);
  }
}
