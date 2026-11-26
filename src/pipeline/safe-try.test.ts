import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { safeTryWith } from "./safe-try.ts";

test("失敗を受け取ったら iterator を閉じて、利用者の後始末を走らせる", async () => {
  const events: string[] = [];
  const safeTry = safeTryWith({});
  const ng: Result.Failure<"NG"> = { type: "Failure", error: "NG" };
  const it: AsyncIterator<Result.Failure<"NG">, Result.Result<void, never>> = {
    next: async () => ({ done: false, value: ng }),
    return: async () => {
      events.push("closed");
      return { done: true, value: Result.succeed() };
    },
  };
  expect(await safeTry(() => it)).toEqual(Result.fail("NG"));
  expect(events).toEqual(["closed"]);
});
