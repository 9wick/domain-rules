import { actor } from "./pipeline/when/builders.ts";
import { defineAction } from "./definition/action.ts";
import { defineModel } from "./definition/model.ts";

// domain ごとに決める型。actor はメソッドを呼ぶ操作者の型で、その domain のすべての線路の状態に入る
export type DomainTypes = { readonly actor: unknown };

// actor の型をここで1回だけ決め、その型を使う部品を返す。rule の check は線路から actor の型を受け取るので、ここで返す必要はない
export const domain = <D extends DomainTypes>() =>
  Object.freeze({
    model: defineModel<D["actor"]>(),
    action: defineAction<D["actor"]>(),
    actor: <S = unknown>(predicate: (a: D["actor"], s: S) => boolean) => actor<D["actor"], S>(predicate),
  });
