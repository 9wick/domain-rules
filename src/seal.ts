import type { Action, Actor, Model, Persisted } from "./model.ts";
import { contentsOf } from "./unchecked.ts";

declare const sealedAs: unique symbol;

// 線路を通ったことの証明。中身は private field に持ち、メソッドが作った値だけが open できる
class Sealed<Kind extends string, Target extends string, Op extends string, C> {
  declare readonly [sealedAs]: { readonly kind: Kind; readonly target: Target; readonly op: Op };
  readonly #contents: C;

  constructor(contents: C) {
    this.#contents = Object.freeze(contents);
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static read(value: object): unknown {
    if (!(#contents in value)) throw new Error("open: メソッドが作った封をした値ではありません");
    return value.#contents;
  }
}

export type AnySealed = Sealed<string, string, string, unknown>;
export type ContentsOf<S> = S extends Sealed<string, string, string, infer C> ? C : never;

export type Persistable<
  M extends Model,
  Op extends "create" | "update" = "create" | "update",
  Pre = Persisted<M>,
  A = Actor,
> = Op extends "create"
  ? Sealed<
      "persistable",
      M["name"],
      "create",
      { readonly pre: null; readonly next: Readonly<Persisted<M>>; readonly actor: A }
    >
  : Sealed<
      "persistable",
      M["name"],
      "update",
      { readonly pre: Readonly<Pre>; readonly next: Readonly<Persisted<M>>; readonly actor: A }
    >;

export type Deletable<M extends Model, Pre = Persisted<M>, A = Actor> = Sealed<
  "deletable",
  M["name"],
  "delete",
  { readonly pre: Readonly<Pre>; readonly actor: A }
>;

export type Decision<Ac extends Action, T = void, A = Actor> = Sealed<
  "decision",
  Ac["name"],
  "decide",
  { readonly value: T; readonly actor: A }
>;

export const seal = <Kind extends string, Target extends string, Op extends string, C>(contents: C) =>
  new Sealed<Kind, Target, Op, C>(contents);

export const open = <S extends AnySealed>(s: S): ContentsOf<S> => contentsOf(s, (value) => Sealed.read(value));
