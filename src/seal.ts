import { opaque, type Phantom, type PhantomKey } from "./erased.ts";
import type { Action, Actor, Model, Persisted } from "./model.ts";

type Sealed<Kind extends string, Target extends string, Op extends string, C> = Phantom<{
  readonly kind: Kind;
  readonly target: Target;
  readonly op: Op;
  readonly contents: C;
}>;

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

type Contents<S extends AnySealed> = S[PhantomKey]["contents"];

export const seal = <S extends AnySealed>(c: Contents<S>): S => opaque<S>(new Seal(c));

export const open = <S extends AnySealed>(s: S): Contents<S> => Seal.open(s);
