import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { TrackKind } from "./when.ts";

// アプリケーションが module augmentation で actor の型を登録する
export interface Register {}
export type Actor = Register extends { actor: infer A } ? A : unknown;

export type Simplify<T> = { [K in keyof T]: T[K] };

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
  with<R>(): Track<K, T, S & R> {
    return new Track<K, T, S & R>(this.kind, this.target);
  }
}

export type ObjectSchema = StandardSchemaV1 & { readonly entries: Readonly<Record<string, StandardSchemaV1>> };

export type Model<
  N extends string = string,
  I extends ObjectSchema = ObjectSchema,
  P extends StandardSchemaV1 = StandardSchemaV1,
> = {
  readonly kind: "model";
  readonly name: N;
  readonly schema: { readonly input: I; readonly persisted: P };
  readonly save: Track<"save", N, SaveStates<StandardSchemaV1.InferOutput<P>, StandardSchemaV1.InferOutput<I>>>;
  readonly delete: Track<"delete", N, DeleteState<StandardSchemaV1.InferOutput<P>>>;
};

export type SaveState<Pre, Next> = {
  readonly pre: Pre;
  readonly next: Next;
  readonly actor: Actor;
  readonly now: number;
};
type UpdatedValue<Pre, Input> = Simplify<
  {
    [K in keyof Pre]: Pre[K] | (K extends keyof Input ? Input[K] : never);
  } & Partial<Omit<Input, keyof Pre>>
>;

export type SaveStates<Pre, Input> =
  | SaveState<null, Input>
  | (Pre extends unknown ? SaveState<Pre, UpdatedValue<Pre, Input>> : never);

export type DeleteState<Pre> = { readonly pre: Pre; readonly next: null; readonly actor: Actor; readonly now: number };

export type Value<M extends Model> = StandardSchemaV1.InferOutput<M["schema"]["input"]>;
export type Persisted<M extends Model> = StandardSchemaV1.InferOutput<M["schema"]["persisted"]>;
export type InputOf<M extends Model> = Partial<StandardSchemaV1.InferInput<M["schema"]["input"]>>;

type OptionalInputId<I extends ObjectSchema> =
  StandardSchemaV1.InferInput<I> extends { readonly id: unknown }
    ? { readonly "model の入力スキーマの id は省略可能でなければならない": true }
    : unknown;

export const model = <const N extends string, I extends ObjectSchema, P extends StandardSchemaV1>(def: {
  readonly name: N;
  readonly schema: { readonly input: I & OptionalInputId<I>; readonly persisted: P };
}): Model<N, I, P> =>
  Object.freeze({
    kind: "model",
    name: def.name,
    schema: def.schema,
    save: new Track<"save", N, SaveStates<StandardSchemaV1.InferOutput<P>, StandardSchemaV1.InferOutput<I>>>(
      "save",
      def.name,
    ),
    delete: new Track<"delete", N, DeleteState<StandardSchemaV1.InferOutput<P>>>("delete", def.name),
  });

export type Action<N extends string = string, I extends StandardSchemaV1 = StandardSchemaV1> = {
  readonly kind: "action";
  readonly name: N;
  readonly input: I;
  readonly decide: Track<"decide", N, DecideState<StandardSchemaV1.InferOutput<I>>>;
};

export type DecideState<I> = { readonly input: I; readonly actor: Actor; readonly now: number };

export const action = <const N extends string, I extends StandardSchemaV1>(def: {
  readonly name: N;
  readonly input: I;
}): Action<N, I> =>
  Object.freeze({
    kind: "action",
    name: def.name,
    input: def.input,
    decide: new Track<"decide", N, DecideState<StandardSchemaV1.InferOutput<I>>>("decide", def.name),
  });
