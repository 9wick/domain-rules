// アプリケーションが module augmentation で actor の型を登録する
export interface Register {}
export type Actor = Register extends { actor: infer A } ? A : unknown;
