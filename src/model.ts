import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { TrackKind } from "./when.ts";

// アプリケーションが module augmentation で actor の型を登録する
export interface Register {}
export type Actor = Register extends { actor: infer A } ? A : unknown;

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

// 項目ごとの schema。更新のときは、入力にある項目だけをその項目の schema で検証する
export type Entries<Out> = { readonly [K in keyof Out]-?: StandardSchemaV1<unknown, Out[K]> };
export type ObjectSchema<In = unknown, Out = unknown> = StandardSchemaV1<In, Out> & { readonly entries: Entries<Out> };

// schema の型を入力・出力の型に分けて持つ。検証の結果の型が、型引数からそのまま決まる
export type Model<N extends string = string, In = unknown, Out = unknown, P = unknown> = {
  readonly kind: "model";
  readonly name: N;
  readonly schema: { readonly input: ObjectSchema<In, Out>; readonly persisted: StandardSchemaV1<unknown, P> };
  readonly onSave: Track<"save", N, SaveState<P | null, Out>>;
  readonly onDelete: Track<"delete", N, DeleteState<P>>;
};

export type SaveState<Pre, Next> = {
  readonly pre: Pre;
  readonly next: Next;
  readonly actor: Actor;
  readonly now: number;
};

export type DeleteState<Pre> = { readonly pre: Pre; readonly next: null; readonly actor: Actor; readonly now: number };

export type Value<M extends Model> = StandardSchemaV1.InferOutput<M["schema"]["input"]>;
export type Persisted<M extends Model> = StandardSchemaV1.InferOutput<M["schema"]["persisted"]>;
export type InputOf<M extends Model> = Partial<StandardSchemaV1.InferInput<M["schema"]["input"]>>;

type OptionalInputId<In> = In extends { readonly id: unknown }
  ? { readonly "model の入力スキーマの id は省略可能でなければならない": true }
  : unknown;

export const model = <const N extends string, In, Out, P>(def: {
  readonly name: N;
  readonly schema: {
    readonly input: StandardSchemaV1<In, Out> & { readonly entries: NoInfer<Entries<Out>> } & NoInfer<
        OptionalInputId<In>
      >;
    readonly persisted: StandardSchemaV1<unknown, P>;
  };
}): Model<N, In, Out, P> =>
  Object.freeze({
    kind: "model",
    name: def.name,
    schema: def.schema,
    onSave: new Track<"save", N, SaveState<P | null, Out>>("save", def.name),
    onDelete: new Track<"delete", N, DeleteState<P>>("delete", def.name),
  });

export type Action<N extends string = string, In = unknown, Out = unknown> = {
  readonly kind: "action";
  readonly name: N;
  readonly input: StandardSchemaV1<In, Out>;
  readonly onDecide: Track<"decide", N, DecideState<Out>>;
};

export type DecideState<I> = { readonly input: I; readonly actor: Actor; readonly now: number };

export const action = <const N extends string, In, Out>(def: {
  readonly name: N;
  readonly input: StandardSchemaV1<In, Out>;
}): Action<N, In, Out> =>
  Object.freeze({
    kind: "action",
    name: def.name,
    input: def.input,
    onDecide: new Track<"decide", N, DecideState<Out>>("decide", def.name),
  });
