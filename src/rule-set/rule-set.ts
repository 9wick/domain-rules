import type { ActionPlan, ActionRules } from "./action-rules.ts";
import type { ModelRules, Plans } from "./model-rules.ts";

// bind に渡せる rule の組。どちらも name・plan・ports・resolveIn を同じ形で持つ
export type RuleSet = ModelRules | ActionRules;

export function plan(set: ModelRules): Plans;
export function plan(set: ActionRules): ActionPlan;
export function plan(set: RuleSet) {
  return set.plan;
}
