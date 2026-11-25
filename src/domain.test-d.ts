import * as v from "valibot";
import { expectTypeOf, test } from "vite-plus/test";
import type { ActionActor } from "./definition/action.ts";
import type { ModelActor } from "./definition/model.ts";
import { domain } from "./domain.ts";

type Operator = { readonly role: "MEMBER" | "ADMIN" };
const { model, action, actor } = domain<{ actor: Operator }>();

test("domain で決めた actor の型が、model と action の線路に入る", () => {
  const item = model({
    name: "item",
    schema: { input: v.object({ id: v.optional(v.string()) }), persisted: v.object({ id: v.string() }) },
  });
  const download = action({ name: "download", input: v.object({ fileId: v.string() }) });
  expectTypeOf<ModelActor<typeof item>>().toEqualTypeOf<Operator>();
  expectTypeOf<ActionActor<typeof download>>().toEqualTypeOf<Operator>();
});

test("domain の actor の述語は、型を書かなくても actor の型を受け取る", () => {
  actor((a) => {
    expectTypeOf(a).toEqualTypeOf<Operator>();
    return true;
  });
  // @ts-expect-error actor の型にない項目は読めない
  actor((a) => a.name === "x");
});
