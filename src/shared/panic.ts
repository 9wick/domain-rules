// 復帰できない異常。呼び出し側の誤りやライブラリの不具合で、Result で返しても利用者が扱いようのないもの。
// throw できるのはこれだけにして、失敗を throw で返す書き方を lint で止める
export class Panic extends Error {
  override readonly name = "Panic";
}
