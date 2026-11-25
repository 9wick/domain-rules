import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Track } from "./track.ts";

// 項目ごとの schema。更新のときは、入力にある項目だけをその項目の schema で検証する
export type Entries<Out> = { readonly [K in keyof Out]-?: StandardSchemaV1<unknown, Out[K]> };
export type ObjectSchema<In = unknown, Out = unknown> = StandardSchemaV1<In, Out> & { readonly entries: Entries<Out> };

// schema の型を入力・出力の型に分けて持つ。検証の結果の型が、型引数からそのまま決まる
export type Model<N extends string = string, In = unknown, Out = unknown, P = unknown, Act = unknown> = {
  readonly kind: "model";
  readonly name: N;
  readonly schema: { readonly input: ObjectSchema<In, Out>; readonly persisted: StandardSchemaV1<unknown, P> };
  readonly onSave: Track<"save", N, SaveState<P | null, Out, Act>>;
  readonly onDelete: Track<"delete", N, DeleteState<P, Act>>;
};

export type SaveState<Pre, Next, Act> = {
  readonly pre: Pre;
  readonly next: Next;
  readonly actor: Act;
  readonly now: number;
};

export type DeleteState<Pre, Act> = {
  readonly pre: Pre;
  readonly next: null;
  readonly actor: Act;
  readonly now: number;
};

export type Value<M extends Model> = StandardSchemaV1.InferOutput<M["schema"]["input"]>;
export type Persisted<M extends Model> = StandardSchemaV1.InferOutput<M["schema"]["persisted"]>;
export type InputOf<M extends Model> = Partial<StandardSchemaV1.InferInput<M["schema"]["input"]>>;
// model を作った domain の actor の型
export type ModelActor<M extends Model> =
  M["onDelete"] extends Track<"delete", string, DeleteState<unknown, infer A>> ? A : never;

type OptionalInputId<In> = In extends { readonly id: unknown }
  ? { readonly "model の入力スキーマの id は省略可能でなければならない": true }
  : unknown;

// actor の型を決めてから model を作る。actor の型は domain で1回だけ書く
export const defineModel =
  <Act>() =>
  <const N extends string, In, Out, P>(def: {
    readonly name: N;
    readonly schema: {
      readonly input: StandardSchemaV1<In, Out> & { readonly entries: NoInfer<Entries<Out>> } & NoInfer<
          OptionalInputId<In>
        >;
      readonly persisted: StandardSchemaV1<unknown, P>;
    };
  }): Model<N, In, Out, P, Act> =>
    Object.freeze({
      kind: "model",
      name: def.name,
      schema: def.schema,
      onSave: new Track<"save", N, SaveState<P | null, Out, Act>>("save", def.name),
      onDelete: new Track<"delete", N, DeleteState<P, Act>>("delete", def.name),
    });
