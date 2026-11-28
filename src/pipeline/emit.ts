import * as Result from "../shared/result.ts";
import type { Track, TrackKind } from "../definition/track.ts";
import type { NoPorts } from "../port/port.ts";
import { rule, type Rule } from "./rule.ts";
import type { WhenParam } from "./when/when.ts";

// 条件に応じてイベントを発行する rule。状態は変えず、失敗もしない。
// event は port を受け取らない。保存が確定する前に配送のための取得が走り、その失敗で保存まで失敗しないようにする
export function emit<K extends TrackKind, T extends string, S, const I extends string, W extends WhenParam<K, S>, Ev>(
  track: Track<K, T, S>,
  def: {
    readonly id: I;
    readonly description: string;
    readonly when: W;
    readonly event: (s: S) => Ev;
  },
): Rule<K, T, I, S, W, void, never, NoPorts, Ev> {
  const base = rule(track, {
    id: def.id,
    description: def.description,
    when: def.when,
    check: () => Result.succeed(),
  });
  return Object.freeze({ ...base, event: (s: S) => def.event(s) });
}
