// app/lib/ownership.ts
//
// 归属哈希：sha256(设备标识 + ':' + 行id)，十六进制小写。
//
// 这个字符串的两个关键性质：
//   1. 它是哈希、不是凭证 —— 所以 select('*')、Realtime 推送即使把它广播出去
//      也没关系，别人无法反推出设备标识，也就无法冒充你。
//   2. 客户端能算出同样的值 —— 所以「这条评论是不是我发的」在浏览器里可以精确
//      判断，不用拿昵称去猜。
//
// ⚠️ 拼接格式必须和 supabase/ownership-rls.sql 里的 tl_owner_hash 完全一致：
//      digest(v_device || ':' || p_id::text, 'sha256')
//    改这里的话，SQL 里的函数要同步改。

import { getDeviceId } from './device';

export async function ownerHash(rowId: string, deviceId?: string | null): Promise<string | null> {
  const device = deviceId ?? getDeviceId();
  if (!device || !rowId) return null;

  // subtle 只在安全上下文可用（https，或 localhost）。不可用时返回 null，
  // 调用方据此不显示删除入口 —— 宁可少显示，也不要误判。
  const subtle = typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : undefined;
  if (!subtle) return null;

  try {
    const bytes = new TextEncoder().encode(`${device}:${rowId}`);
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * 从一批行里挑出「本机拥有」的行 id。
 * @param hashOf 取出该行存储的归属哈希（评论是 author_hash，帖子是 device_hash）
 */
export async function ownedRowIds<T extends { id: string }>(
  rows: T[],
  hashOf: (row: T) => string | null | undefined
): Promise<Set<string>> {
  const device = getDeviceId();
  const mine = new Set<string>();
  if (!device) return mine;

  await Promise.all(
    rows.map(async (row) => {
      const stored = hashOf(row);
      if (!stored) return;
      const computed = await ownerHash(row.id, device);
      if (computed && computed === stored) mine.add(row.id);
    })
  );

  return mine;
}
