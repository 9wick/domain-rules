// まだ消せていない型 assertion。proven.ts の条件を満たさないので、なくす方法が決まるまでここに置く。
// - implFor と runErased: bind の中で型を消した値を扱っているため。bind を型付きにすると消せる
// - boundOf: domain.article の形は、型 assertion なしに作れない。書き方を変えるかどうかを決める必要がある
import type { Result } from "@praha/byethrow";
import type { Bound } from "./bind.ts";
import type { Impl, Impls, Port, PortCall } from "./port.ts";
import type { AnyDecider, AnyRunnable, RuleSet } from "./rules.ts";

// provider は provide で port の型に合わせてから、port の token で登録している
export const implFor = <P extends Port>(impls: Impls, p: P): Impl<P> | undefined =>
  impls.get(p.token) as Impl<P> | undefined;

// bind は model の schema と load から、modelRules が型で確かめた開始の状態を組み立てて線路を走らせる
export const runErased = (
  r: AnyRunnable | AnyDecider,
): ((s: unknown, call: PortCall) => Promise<Result.Result<unknown, unknown>>) =>
  r.run as (s: unknown, call: PortCall) => Promise<Result.Result<unknown, unknown>>;

// bind は rule の組ごとに、その名前で Bound の型どおりのメソッドを置く
export const boundOf = <Sets extends readonly RuleSet[]>(
  _sets: Sets,
  methods: Readonly<Record<string, object>>,
): Bound<Sets> => methods as Bound<Sets>;
