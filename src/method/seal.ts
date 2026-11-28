import type { Action, ActionActor } from "../definition/action.ts";
import type { Model, ModelActor, Persisted } from "../definition/model.ts";
import { Panic } from "../shared/panic.ts";

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

  static contents<C>(s: Sealed<string, string, string, C>): C {
    // 型の上では封をした値しか渡せないが、スプレッドで作り直した値は実行時にも拒む
    if (!(#contents in s)) throw new Panic("open: not a sealed value created by a method");
    return s.#contents;
  }
}

export type Persistable<
  M extends Model,
  Op extends "create" | "update" = "create" | "update",
  Pre = Persisted<M>,
  A = ModelActor<M>,
> = Sealed<
  "persistable",
  M["name"],
  Op,
  // create と update のどちらもありうる値は、中身の型を和にした1つの封の型にする。open は封の型から中身の型を引く
  | ("create" extends Op ? { readonly pre: null; readonly next: Readonly<Persisted<M>>; readonly actor: A } : never)
  | ("update" extends Op
      ? { readonly pre: Readonly<Pre>; readonly next: Readonly<Persisted<M>>; readonly actor: A }
      : never)
>;

export type Deletable<M extends Model, Pre = Persisted<M>, A = ModelActor<M>> = Sealed<
  "deletable",
  M["name"],
  "delete",
  { readonly pre: Readonly<Pre>; readonly actor: A }
>;

export type Decision<Ac extends Action, T = void, A = ActionActor<Ac>> = Sealed<
  "decision",
  Ac["name"],
  "decide",
  { readonly value: T; readonly actor: A }
>;

export const seal = <Kind extends string, Target extends string, Op extends string, C>(contents: C) =>
  new Sealed<Kind, Target, Op, C>(contents);

export const open = <C>(s: Sealed<string, string, string, C>): C => Sealed.contents(s);
