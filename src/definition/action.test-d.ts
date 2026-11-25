import * as v from "valibot";
import { expectTypeOf, test } from "vite-plus/test";
import { defineAction, type ActionActor, type DecideState } from "./action.ts";
import type { Track } from "./track.ts";

type Operator = { readonly role: "MEMBER" | "ADMIN" };

const download = defineAction<Operator>()({
  name: "download",
  input: v.object({ size: v.pipe(v.string(), v.transform(Number)) }),
});

test("判定の線路は、検証後の入力と actor を状態に持つ", () => {
  expectTypeOf(download.onDecide).toEqualTypeOf<Track<"decide", "download", DecideState<{ size: number }, Operator>>>();
});

test("ActionActor は action を作ったときの actor の型", () => {
  expectTypeOf<ActionActor<typeof download>>().toEqualTypeOf<Operator>();
});
