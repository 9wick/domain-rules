// 1回のメソッド呼び出し。scope は bind ごとに1つで、provider の実装はこれを key に登録する
export type Invocation = { readonly scope: object; readonly now: number };
