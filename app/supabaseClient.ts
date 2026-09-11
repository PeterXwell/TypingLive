import { createClient } from '@supabase/supabase-js'
import { getDeviceId } from './lib/device'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co'
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'

// 本机标识随每个请求发出，Supabase 的 RLS 策略据此判断这一行是不是你的
// （见 supabase/ownership-rls.sql）。服务端渲染时没有 localStorage，
// getDeviceId() 返回 null，此时不带这个头；所有数据读写都在客户端发生，
// 所以不影响使用。
const deviceId = getDeviceId()

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    headers: deviceId ? { 'x-device-id': deviceId } : {},
  },
})
