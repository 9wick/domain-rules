import type { PlannedRule, RulesetPorts } from "../pipeline/ruleset.ts";
import type { ActionRules } from "./action-rules.ts";
import type { ModelRules, ModelRulesPorts, Plans } from "./model-rules.ts";

// bind に渡せる rule の組
export type RuleSet = ModelRules | ActionRules;

export type RuleSetPorts<S> = S extends { readonly kind: "modelRules" }
  ? ModelRulesPorts<S>
  : S extends { readonly kind: "actionRules"; readonly rules: infer Rs }
    ? RulesetPorts<Rs>
    : never;

export function plan(set: ModelRules): Plans;
export function plan(set: ActionRules): { readonly rules: readonly PlannedRule[] };
export function plan(set: RuleSet) {
  return set.kind === "actionRules" ? { rules: set.rules.plan } : set.plans;
}
