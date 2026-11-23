import type { Action, Actor, Model, Persisted } from "./model.ts";

declare const sealed: unique symbol;

type Sealed<Kind extends string, Target extends string, Op extends string, C> = {
  readonly [sealed]: { readonly kind: Kind; readonly target: Target; readonly op: Op; readonly contents: C };
};

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

type AnySealed = Sealed<string, string, string, unknown>;

class Seal {
  readonly #contents: unknown;

  constructor(contents: unknown) {
    this.#contents = Object.freeze(contents);
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  static open(value: object): unknown {
    if (!(#contents in value)) throw new Error("open: メソッドが作った封をした値ではありません");
    return value.#contents;
  }
}

export const seal = <S extends AnySealed>(c: S[typeof sealed]["contents"]): S => new Seal(c) as unknown as S;

export const open = <S extends AnySealed>(s: S): S[typeof sealed]["contents"] =>
  Seal.open(s) as S[typeof sealed]["contents"];
