// app/lib/polyfills.ts
//
// Next.js 16 官方支持范围是 Safari 16.4+（见 node_modules/next/dist/docs/03-architecture/supported-browsers.md）。
// 语法层面的兼容（类静态初始化块等）由 package.json 里的 browserslist 交给 SWC 转译；
// 但语法转译不会补齐「运行时 API」，所以这里为 Safari 15.0~15.3 等更旧的 iOS 补齐
// Next.js / Supabase 客户端代码里实际用到的 ES2021+ 方法。
//
// 全部实现都只在缺失时挂载，运行时开销可忽略，不影响新浏览器。

type MutableGlobal = Record<string, unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */

export function installLegacyPolyfills(): void {
  if (typeof window === 'undefined') return;

  try {
    // Array.prototype.at  (Safari 15.4+)
    if (typeof (Array.prototype as any).at !== 'function') {
      Object.defineProperty(Array.prototype, 'at', {
        value: function at(this: any[], index: number) {
          const len = this.length >>> 0;
          const i = Math.trunc(Number(index)) || 0;
          const k = i < 0 ? len + i : i;
          return k < 0 || k >= len ? undefined : this[k];
        },
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }

    // String.prototype.at  (Safari 15.4+)
    if (typeof (String.prototype as any).at !== 'function') {
      Object.defineProperty(String.prototype, 'at', {
        value: function at(this: string, index: number) {
          const str = String(this);
          const len = str.length;
          const i = Math.trunc(Number(index)) || 0;
          const k = i < 0 ? len + i : i;
          return k < 0 || k >= len ? undefined : str.charAt(k);
        },
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }

    // Object.hasOwn  (Safari 15.4+)
    if (typeof (Object as any).hasOwn !== 'function') {
      Object.defineProperty(Object, 'hasOwn', {
        value: function hasOwn(obj: unknown, key: PropertyKey) {
          if (obj === null || obj === undefined) {
            throw new TypeError('Cannot convert undefined or null to object');
          }
          return Object.prototype.hasOwnProperty.call(Object(obj), key);
        },
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }

    // Array.prototype.findLast / findLastIndex  (Safari 15.4+)
    const arrayProto = Array.prototype as any;
    if (typeof arrayProto.findLast !== 'function') {
      Object.defineProperty(Array.prototype, 'findLast', {
        value: function findLast<T>(
          this: T[],
          predicate: (value: T, index: number, array: T[]) => unknown,
          thisArg?: unknown
        ): T | undefined {
          if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
          for (let i = this.length - 1; i >= 0; i--) {
            if (predicate.call(thisArg, this[i], i, this)) return this[i];
          }
          return undefined;
        },
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (typeof arrayProto.findLastIndex !== 'function') {
      Object.defineProperty(Array.prototype, 'findLastIndex', {
        value: function findLastIndex<T>(
          this: T[],
          predicate: (value: T, index: number, array: T[]) => unknown,
          thisArg?: unknown
        ): number {
          if (typeof predicate !== 'function') throw new TypeError('predicate must be a function');
          for (let i = this.length - 1; i >= 0; i--) {
            if (predicate.call(thisArg, this[i], i, this)) return i;
          }
          return -1;
        },
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }

    // structuredClone  (Safari 15.4+)：仅在缺失时用 JSON 兜底，够 Next.js 客户端使用
    const g = globalThis as unknown as MutableGlobal;
    if (typeof g.structuredClone !== 'function') {
      Object.defineProperty(globalThis, 'structuredClone', {
        value: function structuredClone<T>(value: T): T {
          if (value === undefined) return value;
          return JSON.parse(JSON.stringify(value)) as T;
        },
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  } catch {
    // 补齐失败也不能拖垮整站
  }
}
