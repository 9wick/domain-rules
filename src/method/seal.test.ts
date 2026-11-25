import { expect, test } from "vite-plus/test";
import { Panic } from "../shared/panic.ts";
import { open, seal } from "./seal.ts";

test("open は封をしたときの中身を返し、中身は凍結されている", () => {
  const contents = { value: 1 };
  const opened = open(seal<"decision", "download", "decide", { value: number }>(contents));
  expect(opened).toEqual({ value: 1 });
  expect(Object.isFrozen(opened)).toBe(true);
});

test("封をした値は中身を property として見せない", () => {
  const sealed = seal<"decision", "download", "decide", { value: number }>({ value: 1 });
  expect(Object.keys(sealed)).toEqual([]);
  expect(Object.isFrozen(sealed)).toBe(true);
});

test("作り直した値は open できない", () => {
  const sealed = seal<"decision", "download", "decide", { value: number }>({ value: 1 });
  // @ts-expect-error 作り直した値は封をした値の型にならない
  expect(() => open({ ...sealed })).toThrow(Panic);
});
