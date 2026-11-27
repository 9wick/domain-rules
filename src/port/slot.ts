import { Provider, type Context } from "./provider.ts";

// 型 V の値を封をした object に入れ、同じ Brand からだけ型を保ったまま取り出す。
// 封の class を Brand ごとに作り、private field の有無で見分けるので、型の違う値を持つ object の集まりから型を崩さずに引ける
export class Brand<in out V> {
  readonly #Box = class Box {
    readonly #value: V;

    constructor(value: V) {
      this.#value = value;
      Object.freeze(this);
    }

    static open(o: object): V | undefined {
      return #value in o ? o.#value : undefined;
    }
  };

  constructor() {
    Object.freeze(this);
  }

  readonly box = (value: V): object => new this.#Box(value);

  readonly open = (o: object): V | undefined => this.#Box.open(o);
}

// 型 I の実装を1つ差し込める口。状態は持たず、実装は bind が作る Context が持つ
export class Slot<N extends string, in out I> {
  readonly name: N;
  readonly #impl = new Brand<I>();

  constructor(name: N) {
    this.name = name;
    Object.freeze(this);
  }

  readonly provider = (impl: I): Provider<N> => new Provider(this.name, this, this.#impl.box(impl));

  readonly providedIn = (context: Context): boolean => context.has(this);

  readonly implIn = (context: Context): I | undefined => {
    const boxed = context.boxFor(this);
    return boxed === undefined ? undefined : this.#impl.open(boxed);
  };
}
