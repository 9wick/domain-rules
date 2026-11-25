import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { open } from "../index.ts";
import { itemDomain, member, stored } from "../testing/fixtures.ts";

test("時計の provider の値が now として rule に渡る", async () => {
  const r = await itemDomain(() => Result.succeed(stored)).create({ input: { n: 1 }, actor: member });
  expect(open(Result.unwrap(r)).next).toEqual({ id: "new", n: 1 });
});
