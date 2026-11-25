import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Entries, ObjectSchema } from "../definition/model.ts";

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

const unknownKeys = (entries: object, input: State, allowed: (key: string) => boolean): StandardSchemaV1.Issue[] =>
  Object.keys(input)
    .filter((key) => !Object.hasOwn(entries, key) || !allowed(key))
    .map((key) => ({ message: `schema にない項目です: ${key}`, path: [key] }));

const definedEntries = (input: State): State =>
  Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

export const validateWhole = async <Out>(
  schema: ObjectSchema<unknown, Out>,
  input: State,
): Promise<Result.Result<Out, InputFailure>> => {
  const defined = definedEntries(input);
  const unknown = unknownKeys(schema.entries, defined, (key) => key !== "id");
  const r = await validate(schema, defined);
  const issues = [...unknown, ...(Result.isFailure(r) ? r.error : [])];
  if (issues.length > 0 || Result.isFailure(r)) return Result.fail(inputFailure(issues));
  return Result.succeed(r.value);
};

// 更新では入力にある項目だけを、その項目の schema で検証する
export const validatePartial = async <Out>(
  entries: Entries<Out>,
  input: State,
): Promise<Result.Result<Partial<Out>, InputFailure>> => {
  const issues = unknownKeys(entries, input, () => true);
  const defined = definedEntries(input);
  const out: Partial<Out> = {};
  for (const key in entries) {
    if (!Object.hasOwn(defined, key)) continue;
    const r = await validate(entries[key], defined[key], [key]);
    if (Result.isFailure(r)) issues.push(...r.error);
    else out[key] = r.value;
  }
  return issues.length > 0 ? Result.fail(inputFailure(issues)) : Result.succeed(out);
};
