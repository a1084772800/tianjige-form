import cloud from '@lafjs/cloud'

const db = cloud.database()

// 8KB cap：表单字段（uid + 命理基础信息 + 联系方式），不该超 1KB，留 8x 余量挡灌包
const MAX_BODY_BYTES = 8 * 1024

// 公开表单 → 不能 JS 端硬编码 RENDER_SAVE_TOKEN（会被 view-source 拿到）
// 双层防护：
//   1. 服务端写入有 X-Save-Token → 跳过限速（admin / report_upload.py 走此通道）
//   2. 公开 form 没 token → 走 IP 节流（每 IP 5/小时 / 30/天，挡批量灌脏）
//   3. body size guard 8KB（任何路径）
const RATE_PER_HOUR_IP = 5
const RATE_PER_DAY_IP = 30
const RATE_PER_DAY_GLOBAL = 2000  // 2000/天 全局，挡 DDoS

// 进程内存 tracker（重启即清；够挡爆破；不能 100% 防穿透）
const _ipTracker: Map<string, number[]> = (cloud as any)._profileIpTracker || new Map()
;(cloud as any)._profileIpTracker = _ipTracker
let _globalDayCount = (cloud as any)._profileGlobalCount || { day: '', n: 0 }
;(cloud as any)._profileGlobalCount = _globalDayCount

function _extractIp(ctx: any): string {
  const h = ctx.headers || {}
  return (h['cf-connecting-ip'] || h['x-real-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || '').trim() || '?'
}

function _checkRate(ip: string): { ok: boolean; reason?: string } {
  const now = Date.now()
  const dayKey = new Date(now).toISOString().slice(0, 10)
  if (_globalDayCount.day !== dayKey) {
    _globalDayCount.day = dayKey
    _globalDayCount.n = 0
  }
  if (_globalDayCount.n >= RATE_PER_DAY_GLOBAL) {
    return { ok: false, reason: 'global_daily_quota_exceeded' }
  }
  const arr = _ipTracker.get(ip) || []
  const dayAgo = now - 24 * 3600 * 1000
  const hourAgo = now - 3600 * 1000
  const recent = arr.filter(t => t > dayAgo)
  if (recent.length >= RATE_PER_DAY_IP) return { ok: false, reason: 'ip_daily_quota_exceeded' }
  const lastHour = recent.filter(t => t > hourAgo)
  if (lastHour.length >= RATE_PER_HOUR_IP) return { ok: false, reason: 'ip_hourly_quota_exceeded' }
  recent.push(now)
  _ipTracker.set(ip, recent)
  _globalDayCount.n += 1
  // LRU prune（最多记 1000 个 IP）
  if (_ipTracker.size > 1000) {
    const oldest = _ipTracker.keys().next().value
    if (oldest !== undefined) _ipTracker.delete(oldest)
  }
  return { ok: true }
}

export default async function (ctx: FunctionContext) {
  const body = ctx.body || {}
  const { uid } = body

  if (!uid) {
    return { error: 'missing uid' }
  }

  // 1. Size guard（任何路径都过）
  try {
    const bodyJson = JSON.stringify(body)
    const bodyBytes = Buffer.byteLength(bodyJson, 'utf8')
    if (bodyBytes > MAX_BODY_BYTES) {
      return { error: 'body_too_large', actual: bodyBytes, max: MAX_BODY_BYTES }
    }
  } catch (e) {
    return { error: 'invalid_body' }
  }

  // 2. 鉴权 / 限速 双通道
  const expected = (process.env.RENDER_SAVE_TOKEN || '').trim()
  const headers: any = ctx.headers || {}
  const got = (headers['x-save-token'] || headers['X-Save-Token'] || '').toString().trim()
  const hasValidToken = expected && got === expected

  if (!hasValidToken) {
    // 公开 form 通道 → IP 节流
    const ip = _extractIp(ctx)
    const rate = _checkRate(ip)
    if (!rate.ok) {
      return { error: 'rate_limited', reason: rate.reason }
    }
  }

  try {
    await db.collection('form_submissions').add({
      ...body,
      status: 'pending',
      created_at: new Date()
    })
    return { success: true }
  } catch (e) {
    console.error('save_profile error:', e)
    return { error: 'internal error' }
  }
}
