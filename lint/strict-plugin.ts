import { definePlugin, defineRule, type Node } from "vite-plus/lint/plugins";

const selectorRule = (selector: string, message: string) =>
  defineRule({
    meta: { type: "problem", messages: { forbidden: message } },
    create: (context) => ({
      [selector]: (node: Node) => context.report({ node, messageId: "forbidden" }),
    }),
  });

const directive = /^\s*(?:oxlint|eslint)-(?:disable|enable)/;

export default definePlugin({
  meta: { name: "strict" },
  rules: {
    "no-throw": defineRule({
      meta: {
        type: "problem",
        messages: {
          forbidden: "throw できるのは復帰できない異常の Panic だけ。失敗は Result で返す。",
        },
      },
      create: (context) => {
        // 同じ名前の別の class で抜けられないよう、panic.ts から import した Panic だけを認める
        let imported = false;
        return {
          "ImportDeclaration[source.value=/(^|\\/)panic\\.ts$/] ImportSpecifier[imported.name='Panic'][local.name='Panic']":
            () => {
              imported = true;
            },
          "ThrowStatement:not([argument.type='NewExpression'][argument.callee.name='Panic'])": (node: Node) =>
            context.report({ node, messageId: "forbidden" }),
          "ThrowStatement[argument.callee.name='Panic']": (node: Node) => {
            if (!imported) context.report({ node, messageId: "forbidden" });
          },
        };
      },
    }),
    "no-try-catch": selectorRule("TryStatement", "try-catch ではなく Result.try で Result に変換する。"),
    "no-type-predicate": selectorRule(
      "TSTypePredicate",
      "型述語は実装の正しさを TypeScript が検証しないため使わない。schema で検証する。",
    ),
    "no-in-operator": selectorRule(
      // #field in value は private field の有無を確かめる brand check で、型を騙さない
      "BinaryExpression[operator='in']:not([left.type='PrivateIdentifier'])",
      "in による絞り込みは型を騙せるため使わない。",
    ),
    "no-disable-directive": defineRule({
      meta: {
        type: "problem",
        messages: { forbidden: "lint の例外はコメントで作らず、vite.config.ts の overrides に理由と共に書く。" },
      },
      create: (context) => ({
        Program: () => {
          for (const comment of context.sourceCode.getAllComments()) {
            if (directive.test(comment.value)) context.report({ loc: comment.loc, messageId: "forbidden" });
          }
        },
      }),
    }),
  },
});
