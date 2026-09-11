// app/lib/device.ts
//
// 浏览器本地身份：首次访问时生成一个 122 位随机字符串，存在 localStorage。
// 它随每个请求以 x-device-id 头发给 Supabase，RLS 策略据此判断「这行是不是你的」
// （见 supabase/ownership-rls.sql）。
//
// 和之前 tl_user_name（用户自己填的昵称）的区别：昵称不唯一、不保密、还公开
// 印在评论上，做不了权限；这个随机串没人猜得到，等价于一张「持有即拥有」的凭据。
//
// 注意：清缓存 / 换浏览器 / 换设备 = 换了一个身份，会失去对旧内容的修改与删除权。

const DEVICE_KEY = 'tl_device_id';

let cached: string | null = null;

function randomId(): string {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;

  // randomUUID 需要 Safari 15.4+；更老的 iOS 退回 getRandomValues。
  // （app/lib/polyfills.ts 里也给 randomUUID 打了补丁，这里是第二道保险。）
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // 极老的浏览器：非加密随机，只求唯一，不追求不可猜
  return `weak-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 取本机标识，没有就生成并持久化。
 * 服务端渲染时返回 null（没有 localStorage）；所有数据读写都在客户端，
 * 所以服务端拿不到不影响使用。
 */
export function getDeviceId(): string | null {
  if (typeof window === 'undefined') return null;
  if (cached) return cached;

  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing) {
      cached = existing;
      return cached;
    }
    const created = randomId();
    window.localStorage.setItem(DEVICE_KEY, created);
    cached = created;
    return cached;
  } catch {
    // 无痕模式 / 禁用了本地存储：本次会话内仍然可用，只是刷新后会变一个新身份
    cached = cached ?? randomId();
    return cached;
  }
}
