import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { TrackKind } from "./when.ts";

// アプリケーションが module augmentation で actor の型を登録する
export interface Register {}
export type Actor = Register extends { actor: infer A } ? A : unknown;

export type Simplify<T> = { [K in keyof T]: T[K] } & {};

// check の成功の値を状態に重ねる。next だけは項目ごとに重ね、ほかの名前は置き換えるか足す
export type Overlay<S, O> = S extends unknown
  ? O extends unknown
    ? [O] extends [void | undefined | null]
      ? S
      : Simplify<{
          [K in keyof S | keyof O]: K extends keyof O
            ? K extends "next"
              ? K extends keyof S
                ? Simplify<Omit<S[K], keyof O[K]> & O[K]>
                : O[K]
              : O[K]
            : K extends keyof S
              ? S[K]
              : never;
        }>
    : never
  : never;

declare const trackState: unique symbol;

export type Track<K extends TrackKind, T extends string, S> = {
  readonly kind: K;
  readonly target: T;
  readonly [trackState]: S;
  with<R>(): Track<K, T, Overlay<S, R>>;
};

export const track = <K extends TrackKind, T extends string, S>(kind: K, target: T): Track<K, T, S> => {
  const t = Object.freeze({ kind, target, with: () => t }) as unknown as Track<K, T, S>;
  return t;
};

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
    save: track("save", def.name),
    delete: track("delete", def.name),
  }) as Model<N, I, P>;

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
  Object.freeze({ kind: "action", name: def.name, input: def.input, decide: track("decide", def.name) }) as Action<
    N,
    I
  >;
