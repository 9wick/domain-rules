export type TrackKind = "save" | "delete" | "decide";

declare const trackState: unique symbol;

// rule をどの線路に置くかと、その線路で rule が受け取る状態の型を表す
export class Track<K extends TrackKind, T extends string, S> {
  declare readonly [trackState]: S;
  readonly kind: K;
  readonly target: T;

  constructor(kind: K, target: T) {
    this.kind = kind;
    this.target = target;
    Object.freeze(this);
  }

  // 前の rule が昇格させた状態を前提にする
  assuming<R>(): Track<K, T, S & R> {
    return new Track<K, T, S & R>(this.kind, this.target);
  }
}
