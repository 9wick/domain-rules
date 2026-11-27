import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { domainDefinitionKit } from "./domain-definition-kit.ts";

type Operator = { readonly role: "MEMBER" | "ADMIN" };
const { model, action, actor } = domainDefinitionKit<{ actor: Operator }>();

test("model と action は、渡した定義から作る", () => {
  const item = model({
    name: "item",
    schema: {
      key: v.object({ id: v.optional(v.string()) }),
      value: v.object({}),
      persisted: v.object({ id: v.string() }),
    },
  });
  const download = action({ name: "download", input: v.object({ fileId: v.string() }) });
  expect([item.name, item.onSave.target]).toEqual(["item", "item"]);
  expect([download.name, download.onDecide.target]).toEqual(["download", "download"]);
});

test("actor は、状態の actor と状態そのものを述語に渡す", () => {
  const adminOnCreate = actor((a, s: { readonly pre: unknown }) => a.role === "ADMIN" && s.pre === null);
  expect(adminOnCreate({ actor: { role: "ADMIN" }, pre: null })).toBe(true);
  expect(adminOnCreate({ actor: { role: "MEMBER" }, pre: null })).toBe(false);
  expect(adminOnCreate.description).toEqual({ kind: "actor" });
});
