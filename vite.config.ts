import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // 既存コードは型の宣言が長く、既定の 100 桁では差分の大半が折り返しになるため広げる
    printWidth: 120,
  },
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "import", "vitest"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "strict", specifier: "./lint/strict-plugin.ts" },
    ],
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",

      // 型を騙す書き方
      "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "typescript/no-non-null-assertion": "error",
      "typescript/no-explicit-any": "error",
      "typescript/ban-ts-comment": ["error", { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true }],
      "typescript/no-unsafe-type-assertion": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/no-unsafe-function-type": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "strict/no-type-predicate": "error",
      "strict/no-in-operator": "error",

      // 型が保証する前提を曖昧にする書き方
      "typescript/strict-boolean-expressions": "error",
      "typescript/no-unnecessary-condition": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/restrict-template-expressions": "error",
      "typescript/restrict-plus-operands": "error",
      "typescript/no-base-to-string": "error",
      "typescript/prefer-nullish-coalescing": "error",

      // 失敗を Result で表す
      "strict/no-throw": "error",
      "strict/no-try-catch": "error",
      "typescript/only-throw-error": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/await-thenable": "error",

      // 例外はこのファイルの overrides にだけ書く
      "strict/no-disable-directive": "error",

      // check の第2引数は requires の port と同じ名前で受け取るのが README の書き方で、外側の宣言と名前が重なる
      "eslint/no-shadow": "off",
      "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "expectTypeOf"] }],
    },
    overrides: [
      // ── テストの方針:テストでだけ許すもの ──
      {
        files: ["test/**/*.ts"],
        rules: {
          // 型の契約テストは「コンパイルできないこと」を ts-expect-error のコメントで確かめる。理由の説明は必須にする
          "typescript/ban-ts-comment": ["error", { "ts-expect-error": "allow-with-description", "ts-ignore": true }],
          // rule の check や provider が throw したときの振る舞いを確かめるため、throw を書く
          "strict/no-throw": "off",
          // brand 付きの id や、わざと型に合わない値を作って渡す
          "typescript/consistent-type-assertions": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "typescript/no-unsafe-assignment": "off",
          // README の例と同じく、actor の絞り込みに型述語を使う
          "strict/no-type-predicate": "off",
        },
      },
      {
        // ts-expect-error のコメントだけで確かめる型のテストは、実行時の assertion を持たない
        files: ["test/types.ts", "test/engine.test.ts"],
        rules: { "vitest/expect-expect": "off" },
      },
      // ── 実装の例外:そのファイルが何であるかによって、ルールが守る性質が別の形で保たれるもの ──
      {
        // 復帰できない異常(provider の重複・不足、偽造された値)は throw で止める
        files: ["src/bind.ts", "src/seal.ts"],
        rules: { "strict/no-throw": "off" },
      },
      {
        // check には port の成功の値だけを渡すため、port の失敗は throw で check を抜け、ここで Result に戻す
        files: ["src/port.ts"],
        rules: { "strict/no-throw": "off", "strict/no-try-catch": "off", "typescript/only-throw-error": "off" },
      },
      // ── 負債:実装を直して消すもの。直したら該当のルールをここから消す ──
      // 実行時の線路は値を unknown のまま扱い、型の上の API とは any と型 assertion でつないでいる。
      // 返済:実行時の状態に型引数を通すか、避けられない変換を名前の付いた1つの module に集めて、ほかのファイルから assertion をなくす
      {
        files: ["src/bind.ts"],
        rules: {
          "strict/no-in-operator": "off",
          "typescript/consistent-type-assertions": "off",
          "typescript/no-explicit-any": "off",
          "typescript/no-generated-empty-object-type": "off",
          "typescript/no-non-null-assertion": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
      {
        files: ["src/model.ts"],
        rules: {
          "typescript/consistent-type-assertions": "off",
          "typescript/no-generated-empty-object-type": "off",
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
      {
        files: ["src/port.ts"],
        rules: {
          "typescript/consistent-type-assertions": "off",
          "typescript/no-explicit-any": "off",
          "typescript/no-non-null-assertion": "off",
          "typescript/no-unnecessary-type-arguments": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-return": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "typescript/strict-boolean-expressions": "off",
        },
      },
      {
        files: ["src/rule.ts"],
        rules: {
          "typescript/consistent-type-assertions": "off",
          "typescript/no-explicit-any": "off",
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
      {
        files: ["src/rules.ts"],
        rules: {
          "typescript/consistent-type-assertions": "off",
          "typescript/no-explicit-any": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
      {
        files: ["src/seal.ts"],
        rules: { "typescript/consistent-type-assertions": "off", "typescript/no-unsafe-type-assertion": "off" },
      },
      {
        files: ["src/when.ts"],
        rules: {
          "typescript/consistent-type-assertions": "off",
          "typescript/no-explicit-any": "off",
          "typescript/no-unnecessary-type-parameters": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "typescript/strict-boolean-expressions": "off",
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
      reportUnusedDisableDirectives: "error",
    },
  },
});
