import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Actor } from "./actor.ts";
import { Track } from "./track.ts";

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
