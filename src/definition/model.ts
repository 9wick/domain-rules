import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Panic } from "../shared/panic.ts";
import { Track } from "./track.ts";

// 項目ごとの schema。更新のときは、入力にある項目だけをその項目の schema で検証する
export type Entries<Out> = { readonly [K in keyof Out]-?: StandardSchemaV1<unknown, Out[K]> };
// 項目ごとの schema の置き場所はライブラリで違う。Valibot は entries、Zod は shape に置く
type FieldsOf<E> =
  | { readonly entries: E; readonly shape?: undefined }
  | { readonly shape: E; readonly entries?: undefined };

// 型で entries か shape を必須にしているので、どちらも無いのは型を外した呼び出しだけ
const entriesOf = <E>(schema: FieldsOf<E>): E => {
  const entries = schema.entries ?? schema.shape;
  if (entries === undefined) throw new Panic("defineModel: key と value の schema には entries か shape が必要です");
  return entries;
};

// 線路に載るモデルの値は key と value を合わせたもの
export type ValueOf<KO, VO> = KO & VO;

// key はモデルを特定する項目、value はモデルが持つ項目。schema の型を入力・出力の型に分けて持つ
export type Model<
  N extends string = string,
  KI = unknown,
  KO = unknown,
  VI = unknown,
  VO = unknown,
  P = unknown,
  Act = unknown,
> = {
  readonly kind: "model";
  readonly name: N;
  readonly schema: {
    readonly key: StandardSchemaV1<KI, KO>;
    readonly value: StandardSchemaV1<VI, VO>;
    readonly persisted: StandardSchemaV1<unknown, P>;
  };
  readonly entries: { readonly key: Entries<KO>; readonly value: Entries<VO> };
  readonly onSave: Track<"save", N, SaveState<P | null, ValueOf<KO, VO>, Act>, keyof KO & string>;
  readonly onDelete: Track<"delete", N, DeleteState<P, KO, Act>>;
};

// input は呼び出し時に指定した項目だけを持つ。next と同じ値でも、指定したことは input でしか分からない
export type SaveState<Pre, Next, Act> = {
  readonly pre: Pre;
  readonly next: Next;
  readonly input: Readonly<Partial<Next>>;
  readonly actor: Act;
  readonly now: number;
};

// delete の入力は、消すモデルを特定する key だけ
export type DeleteState<Pre, Key, Act> = {
  readonly pre: Pre;
  readonly next: null;
  readonly input: Readonly<Key>;
  readonly actor: Act;
  readonly now: number;
};

export type Value<M extends Model> = ValueOf<
  StandardSchemaV1.InferOutput<M["schema"]["key"]>,
  StandardSchemaV1.InferOutput<M["schema"]["value"]>
>;
export type Persisted<M extends Model> = StandardSchemaV1.InferOutput<M["schema"]["persisted"]>;
// model を作った domain の actor の型
export type ModelActor<M extends Model> =
  M["onDelete"] extends Track<"delete", string, DeleteState<unknown, unknown, infer A>> ? A : never;

type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];

// 入力で省略できる項目が検証のあとで必ずあるなら、schema が既定値を補っている。既定値はルールで next に入れる
type NoDefault<In, Out> = [Exclude<OptionalKeys<In>, OptionalKeys<Out>>] extends [never]
  ? unknown
  : {
      readonly "schema の optional には既定値を書けない。既定値はルールで next に入れる": Exclude<
        OptionalKeys<In>,
        OptionalKeys<Out>
      >;
    };

// key と value が同じ項目を持つと、next でどちらの値が残るかが決まらない
type Disjoint<KO, VO> = [Extract<keyof KO, keyof VO>] extends [never]
  ? unknown
  : { readonly "key と value に同じ項目は書けない": Extract<keyof KO, keyof VO> };

// create では id をまだ持たないので、key の id は省略できる形で書く。update と delete では id を必須として扱う
type OptionalId<KI> = KI extends { readonly id: unknown }
  ? { readonly "key の schema の id は省略可能でなければならない": true }
  : unknown;

// actor の型を決めてから model を作る。actor の型は domain で1回だけ書く
export const defineModel =
  <Act>() =>
  <const N extends string, KI, KO, VI, VO, P>(def: {
    readonly name: N;
    readonly schema: {
      readonly key: StandardSchemaV1<KI, KO> &
        NoInfer<FieldsOf<Entries<KO>>> &
        NoInfer<NoDefault<KI, KO> & OptionalId<KI>>;
      readonly value: StandardSchemaV1<VI, VO> &
        NoInfer<FieldsOf<Entries<VO>>> &
        NoInfer<NoDefault<VI, VO> & Disjoint<KO, VO>>;
      readonly persisted: StandardSchemaV1<unknown, P>;
    };
  }): Model<N, KI, KO, VI, VO, P, Act> =>
    Object.freeze({
      kind: "model",
      name: def.name,
      schema: def.schema,
      entries: { key: entriesOf<Entries<KO>>(def.schema.key), value: entriesOf<Entries<VO>>(def.schema.value) },
      onSave: new Track<"save", N, SaveState<P | null, ValueOf<KO, VO>, Act>, keyof KO & string>("save", def.name),
      onDelete: new Track<"delete", N, DeleteState<P, KO, Act>>("delete", def.name),
    });
