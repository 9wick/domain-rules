import { describe as group, expect, test } from "vite-plus/test";
import { actor, always, and, changed, describe, next, not, onCreate, or, pre } from "../../index.ts";

type S = { pre: { status: string } | null; next: { status: string }; actor: { role: string } };
const state = (p: string | null, n: string, role = "MEMBER"): S => ({
  pre: p === null ? null : { status: p },
  next: { status: n },
  actor: { role },
});

group("changed", () => {
  const cases: [string, (s: S) => boolean, [string | null, string, boolean][]][] = [
    [
      "項目だけ",
      changed("status"),
      [
        [null, "DRAFT", true],
        ["DRAFT", "DRAFT", false],
        ["DRAFT", "PUBLISHED", true],
      ],
    ],
    [
      "pre だけ",
      changed("status", { pre: "DRAFT" }),
      [
        [null, "DRAFT", false],
        ["DRAFT", "PUBLISHED", true],
        ["PUBLISHED", "ARCHIVED", false],
        ["DRAFT", "DRAFT", false],
      ],
    ],
    [
      "next だけ",
      changed("status", { next: "PUBLISHED" }),
      [
        [null, "PUBLISHED", true],
        [null, "DRAFT", false],
        ["DRAFT", "PUBLISHED", true],
        ["PUBLISHED", "PUBLISHED", false],
      ],
    ],
    [
      "pre と next",
      changed("status", { pre: "DRAFT", next: "PUBLISHED" }),
      [
        [null, "PUBLISHED", false],
        ["DRAFT", "PUBLISHED", true],
        ["ARCHIVED", "PUBLISHED", false],
        ["DRAFT", "ARCHIVED", false],
      ],
    ],
    [
      "undefined は条件なし",
      changed("status", { pre: undefined, next: undefined }),
      [
        [null, "DRAFT", true],
        ["DRAFT", "PUBLISHED", true],
      ],
    ],
  ];
  for (const [name, when, rows] of cases) {
    test.each(rows)(`${name}: pre=%s next=%s → %s`, (p, n, expected) => {
      expect(when(state(p, n))).toBe(expected);
    });
  }
});

const isDraft = (v: { status: string }) => v.status === "DRAFT";

group("ほかの when", () => {
  const calls: readonly (readonly [string, (s: S) => boolean, S, boolean])[] = [
    ["always", always, state("DRAFT", "DRAFT"), true],
    ["onCreate は新規作成", onCreate, state(null, "DRAFT"), true],
    ["onCreate は更新では偽", onCreate, state("DRAFT", "DRAFT"), false],
    ["pre は新規作成では偽", pre(isDraft), state(null, "DRAFT"), false],
    ["pre は既存の値を見る", pre(isDraft), state("DRAFT", "PUBLISHED"), true],
    ["next は変更後の値を見る", next(isDraft), state("PUBLISHED", "DRAFT"), true],
    ["actor", actor((a: { role: string }) => a.role === "ADMIN"), state("DRAFT", "DRAFT", "ADMIN"), true],
    [
      "actor は状態も受け取る",
      actor((a: { role: string }, s: S) => a.role === "MEMBER" && s.pre === null),
      state(null, "DRAFT"),
      true,
    ],
    ["and", and(not(onCreate), changed("status")), state("DRAFT", "PUBLISHED"), true],
    ["and はすべてを要求する", and(not(onCreate), changed("status")), state(null, "PUBLISHED"), false],
    ["or", or(onCreate, next(isDraft)), state("PUBLISHED", "DRAFT"), true],
    ["or はどれも偽なら偽", or(onCreate, next(isDraft)), state("DRAFT", "PUBLISHED"), false],
    ["手書きの関数", describe("下書きのまま", (s: S) => s.next.status === "DRAFT"), state("DRAFT", "DRAFT"), true],
  ];
  test.each(calls)("%s", (_, when, s, expected) => {
    expect(when(s)).toBe(expected);
  });

  test("組み合わせた when の説明は、組み合わせた形を保つ", () => {
    expect(and(not(onCreate), changed("status", { pre: "DRAFT" })).description).toEqual({
      kind: "and",
      conditions: [
        { kind: "not", condition: { kind: "onCreate" } },
        { kind: "changed", field: "status", pre: "DRAFT" },
      ],
    });
    expect(describe("下書きのまま", () => true).description).toEqual({ kind: "custom", description: "下書きのまま" });
  });
});
