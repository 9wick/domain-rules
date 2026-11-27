import * as Result from "../shared/result.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Entries } from "../definition/model.ts";

export type State = Readonly<Record<string, unknown>>;

export type InputFailure = {
  readonly step: "input";
  readonly error: { readonly issues: readonly StandardSchemaV1.Issue[] };
};

export const inputFailure = (issues: readonly StandardSchemaV1.Issue[]): InputFailure => ({
  step: "input",
  error: { issues },
});

export const validate = async <O>(
  schema: StandardSchemaV1<unknown, O>,
  value: unknown,
  path: readonly PropertyKey[] = [],
): Promise<Result.Result<O, StandardSchemaV1.Issue[]>> => {
  const r = await schema["~standard"].validate(value);
  return r.issues !== undefined
    ? Result.fail(r.issues.map((i) => ({ ...i, path: [...path, ...(i.path ?? [])] })))
    : Result.succeed(r.value);
};

// 入力のうち、その schema の項目だけを取り出す。key と value の schema は、入力を項目の名前で分け合う
export const pickEntries = (entries: object, input: State): State =>
  Object.fromEntries(Object.entries(input).filter(([key]) => Object.hasOwn(entries, key)));

export const unknownKeys = (input: State, allowed: (key: string) => boolean): StandardSchemaV1.Issue[] =>
  Object.keys(input)
    .filter((key) => !allowed(key))
    .map((key) => ({ message: `schema にない項目です: ${key}`, path: [key] }));

const definedEntries = (input: State): State =>
  Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

export const validateWhole = async <Out>(
  schema: StandardSchemaV1<unknown, Out>,
  input: State,
): Promise<Result.Result<Out, StandardSchemaV1.Issue[]>> => validate(schema, definedEntries(input));

// 更新では入力にある項目だけを、その項目の schema で検証する
export const validatePartial = async <Out>(
  entries: Entries<Out>,
  input: State,
): Promise<Result.Result<Partial<Out>, StandardSchemaV1.Issue[]>> => {
  const issues: StandardSchemaV1.Issue[] = [];
  const defined = definedEntries(input);
  const out: Partial<Out> = {};
  for (const key in entries) {
    if (!Object.hasOwn(defined, key)) continue;
    const r = await validate(entries[key], defined[key], [key]);
    if (r.type === "Failure") issues.push(...r.error);
    else out[key] = r.value;
  }
  return issues.length > 0 ? Result.fail(issues) : Result.succeed(out);
};

// 更新では、差分に既存の値を重ねた値が value の schema 全体(項目をまたぐ検証を含む)を満たすかを確かめる。
// 出力は捨てる。既存の値から引き継いだ項目は永続化の型のまま残し、変換を二度かけないため
export const checkWhole = async (schema: StandardSchemaV1, next: State): Promise<Result.Result<void, InputFailure>> => {
  const r = await validate(schema, definedEntries(next));
  return r.type === "Failure" ? Result.fail(inputFailure(r.error)) : Result.succeed();
};
