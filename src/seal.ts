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
  ? Sealed<"persistable", M["name"], "create", { readonly pre: null; readonly next: Readonly<Persisted<M>>; readonly actor: A }>
  : Sealed<"persistable", M["name"], "update", { readonly pre: Readonly<Pre>; readonly next: Readonly<Persisted<M>>; readonly actor: A }>;

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

// 中身を封をした値そのものに結び付ける。作り直した値は登録されていないので open できない
const contents = new WeakMap<object, unknown>();

export const seal = <S extends AnySealed>(c: S[typeof sealed]["contents"]): S => {
  const s = Object.freeze({}) as S;
  contents.set(s, Object.freeze(c));
  return s;
};

export const open = <S extends AnySealed>(s: S): S[typeof sealed]["contents"] => {
  if (!contents.has(s)) throw new Error("open: メソッドが作った封をした値ではありません");
  return contents.get(s) as S[typeof sealed]["contents"];
};
