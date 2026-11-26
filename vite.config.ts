import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: { index: "src/index.ts" },
    dts: true,
    deps: {
      // 小さな自前のユーティリティなので dist に取り込み、利用者の依存を増やさない。ほかの依存が紛れ込んだらビルドを止める
      onlyBundle: ["as-free"],
    },
  },
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
      // 型を組み立てる途中の汎用の型は、型引数を決める前に {} へ解決されて誤検出になる
      "typescript/no-generated-empty-object-type": "off",
      "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "expectTypeOf"] }],
    },
    overrides: [
      // ── テストの方針:テストでだけ許すもの ──
      {
        files: ["test/**/*.ts", "src/**/*.test.ts", "src/**/*.test-d.ts"],
        rules: {
          // 型の契約テストは「コンパイルできないこと」を ts-expect-error のコメントで確かめる。理由の説明は必須にする
          "typescript/ban-ts-comment": ["error", { "ts-expect-error": "allow-with-description", "ts-ignore": true }],
          // rule の check や provider が throw したときの振る舞いを確かめるため、throw を書く
          "strict/no-throw": "off",
          // README の例と同じく、actor の絞り込みに型述語を使う
          "strict/no-type-predicate": "off",
          // 封をした値を作り直しても open できないことを、spread で作り直して確かめる
          "typescript/no-misused-spread": "off",
        },
      },
      {
        // ts-expect-error のコメントだけで確かめる型のテストは、実行時の assertion を持たない
        files: ["**/*.test-d.ts"],
        rules: { "vitest/expect-expect": "off" },
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
