// instrumentation-client.ts
//
// 在所有客户端代码（包括 Next.js 自身的运行时）执行前运行。
// 这里只做一件事：为 iOS Safari < 15.4 等旧版 WebKit 补齐缺失的 ES2021+ 运行时 API，
// 避免客户端脚本直接抛错导致整站「服务端 HTML 正常、但完全没有交互」。
//
// 语法层面的兼容（如 Safari 16.4 才支持的类静态初始化块）由 package.json 的
// browserslist 交给 SWC 转译，不需要在这里处理。

import { installLegacyPolyfills } from '@/app/lib/polyfills';

installLegacyPolyfills();
