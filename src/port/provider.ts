import { Panic } from "../shared/panic.ts";

// provider は、ある差し込み口の型で作った実装を封をして持つだけの値。
// 差し込み口の provider からしか作れないので、差し込み口と違う型の実装を持つ provider は作れない
export class Provider<N extends string = string> {
  readonly name: N;
  // どの差し込み口の実装か。bind はこれを key に Context を作る
  readonly slot: object;
  readonly #boxed: object;

  constructor(name: N, slot: object, boxed: object) {
    this.name = name;
    this.slot = slot;
    this.#boxed = boxed;
    Object.freeze(this);
  }

  // static にせずインスタンスに持たせる。ESM と CommonJS の両方が読み込まれると Provider の class が2つでき、
  // 別の側の class からはこの private field を読めないため、値を作った側の class に読ませる
  readonly boxed = (): object => this.#boxed;
}

// bind ごとに1つ作る、差し込み口ごとの実装の一覧。作ったあとは変わらない
export class Context {
  readonly #providers: ReadonlyMap<object, Provider>;

  constructor(providers: readonly Provider[]) {
    const map = new Map<object, Provider>();
    for (const p of providers) {
      // 復帰できない異常: 同じ差し込み口の provider を同じ bind に2つ渡している
      if (map.has(p.slot)) throw new Panic(`bind: port "${p.name}" の provider が重複しています`);
      map.set(p.slot, p);
    }
    this.#providers = map;
    Object.freeze(this);
  }

  readonly has = (slot: object): boolean => this.#providers.has(slot);

  readonly boxFor = (slot: object): object | undefined => {
    const p = this.#providers.get(slot);
    return p?.boxed();
  };
}

type Providable<N extends string, I> = { readonly provider: (impl: I) => Provider<N> };
type Valuable<N extends string, V> = { readonly valued: (v: V) => Provider<N> };

export const provide = Object.assign(
  <N extends string, I>(target: Providable<N, I>, impl: NoInfer<I>): Provider<N> => target.provider(impl),
  { value: <N extends string, V>(target: Valuable<N, V>, v: NoInfer<V>): Provider<N> => target.valued(v) },
);
