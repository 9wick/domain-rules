import { expect, test } from "vite-plus/test";
import { Track } from "./track.ts";

test("assuming は同じ線路の別の Track を返し、元の Track を変えない", () => {
  const track = new Track<"save", "item", { readonly n: number }>("save", "item");
  const assumed = track.assuming<{ readonly checked: true }>();
  expect(assumed).not.toBe(track);
  expect([assumed.kind, assumed.target]).toEqual(["save", "item"]);
  expect(Object.isFrozen(assumed)).toBe(true);
});
