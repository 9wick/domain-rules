import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { defineModel } from "./model.ts";

const schema = {
  input: v.object({ id: v.optional(v.string()), n: v.number() }),
  persisted: v.object({ id: v.string(), n: v.number() }),
};

test("model は名前と schema を持ち、保存と削除の線路をその名前で作る", () => {
  const item = defineModel<unknown>()({ name: "item", schema });
  expect(item.name).toBe("item");
  expect(item.schema).toBe(schema);
  expect([item.onSave.kind, item.onSave.target]).toEqual(["save", "item"]);
  expect([item.onDelete.kind, item.onDelete.target]).toEqual(["delete", "item"]);
  expect(Object.isFrozen(item)).toBe(true);
});
