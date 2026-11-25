import { Result } from "@praha/byethrow";
import { expect, test } from "vite-plus/test";
import { port } from "../port/port.ts";
import { resolvePorts } from "./requires.ts";

test("resolvePorts は requires の key ごとに、1回の呼び出しに束ねた port の関数を作る", async () => {
  const double = port("double").of<(n: number) => number>();
  const greet = port("greet").of<(name: string) => string>();
  const scope = {};
  double.provider((n) => Result.succeed(n * 2)).registerIn(scope);
  greet.provider((name) => Result.succeed(`hi ${name}`)).registerIn(scope);
  const fns = resolvePorts({ double, greet }, { scope, now: 0 });
  expect(Object.keys(fns)).toEqual(["double", "greet"]);
  expect(await fns.double(2)).toEqual(Result.succeed(4));
  expect(await fns.greet("a")).toEqual(Result.succeed("hi a"));
});
