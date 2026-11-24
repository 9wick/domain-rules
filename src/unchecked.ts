// まだ消せていない型 assertion。keyed.ts の条件を満たさないので、なくす方法が決まるまでここに置く。
// - boundOf: rule の組が作るメソッドの型が消えていて、メソッドがあるかないかの型を実装と照らし合わせられない
import type { Bound } from "./bind.ts";
import type { RuleSet } from "./rules.ts";

// bind は rule の組ごとに、その名前で Bound の型どおりのメソッドを置く
export const boundOf = <Sets extends readonly RuleSet[]>(
  _sets: Sets,
  methods: Readonly<Record<string, object>>,
): Bound<Sets> => methods as Bound<Sets>;
