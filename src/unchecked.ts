// まだ消せていない型 assertion。proven.ts の条件を満たさないので、なくす方法が決まるまでここに置く。
// - implFor: provider を port の token で引く Map は、port ごとの実装の型を持てないため
// - boundOf: domain.article の形は、型 assertion なしに作れない。書き方を変えるかどうかを決める必要がある
import type { Bound } from "./bind.ts";
import type { Impl, Impls, Port } from "./port.ts";
import type { RuleSet } from "./rules.ts";

// provider は provide で port の型に合わせてから、port の token で登録している
export const implFor = <P extends Port>(impls: Impls, p: P): Impl<P> | undefined =>
  impls.get(p.token) as Impl<P> | undefined;

// bind は rule の組ごとに、その名前で Bound の型どおりのメソッドを置く
export const boundOf = <Sets extends readonly RuleSet[]>(
  _sets: Sets,
  methods: Readonly<Record<string, object>>,
): Bound<Sets> => methods as Bound<Sets>;
