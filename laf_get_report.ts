import cloud from '@lafjs/cloud'
import * as crypto from 'crypto'

const db = cloud.database()
const JWT_SECRET = process.env.JWT_SECRET

// ── 0913 安全修（审查 A-02）───────────────────────────────────────────────────
// 报告正文开头就是公历生日、农历、性别、生肖、四柱八字 —— 个人敏感信息，此前「知道 id 就能读」，
// 连伪造的 Authorization 都照样 200（根本没有鉴权分支）。
//
// ⚠️ 审查报告给的补丁（patches/A_02_get_report_owner_gate.diff：JWT + uid 比对）**不能直接上**，
//    我按「带合法身份仍然能进」这条阴性对照核过，它会把**全部**正常读者挡在门外：
//      · 唯一的调用方是 tianjige-form/report.html:119，`fetch(.../get_report?id=...)`
//        **一个 Authorization 都不带** —— 它是企微客服发给用户的 H5 链接，用户根本没有网页账号；
//      · reports.uid 存的是**企微 open_id**（wm8-xdMgAAwX…），users._id 是 laf id，
//        两套身份从设计上就没打通（同一份报告 A-14 自己写了：reports→users 21/25 挂不上）。
//    也就是说「JWT 的 uid == report.uid」这个条件在生产里几乎恒为假。原样上线＝报告页全线 403。
//    所以这一版只做**不会误伤**的两件，真正的身份闸留给 owner 拍板（见回报的「要 owner 定的」）。
//
//   ① is_public === false 的报告才要身份：本人 JWT（uid 相符）或 X-Save-Token。
//      字段缺失＝照旧可读，所以存量 25 条与 report.html 现有链路**零影响**；
//      这是给 owner 的开关，不是默认行为。
//   ② 补上「猜 id 无频控」那半：同一 IP 一小时内**猜空**次数设上限，超限后再猜空返 429。
//      **命中永远照常返回**，闸只长在 miss 那条路上：正常读者点的是发给他的真链接，
//      miss 恒为 0，所以这条对真实读者是零成本，也不会出现「同 IP 有人扫 → 真读者被 429」。
//
// ⚠️ 计数器是**进程内**的（同 laf_save_profile.ts 那套），laf 多实例时上限会被放宽到
//    「实例数 × 上限」。刻意取舍：不为限流去写生产库。
const MISS_PER_HOUR_IP = 20

const _missTracker: Map<string, number[]> = (cloud as any)._reportMissTracker || new Map()
;(cloud as any)._reportMissTracker = _missTracker

function _extractIp(ctx: any): string {
  const h = ctx.headers || {}
  return (h['cf-connecting-ip'] || h['x-real-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || '').trim() || '?'
}

function _missCount(ip: string): number {
  const hourAgo = Date.now() - 3600 * 1000
  const recent = (_missTracker.get(ip) || []).filter(t => t > hourAgo)
  _missTracker.set(ip, recent)
  return recent.length
}

function _noteMiss(ip: string): void {
  const hourAgo = Date.now() - 3600 * 1000
  const recent = (_missTracker.get(ip) || []).filter(t => t > hourAgo)
  recent.push(Date.now())
  _missTracker.set(ip, recent)
  if (_missTracker.size > 1000) {
    const oldest = _missTracker.keys().next().value
    if (oldest !== undefined) _missTracker.delete(oldest)
  }
}

// 与 login/functions/user.ts 逐字同一套校验（HS256 + exp），不另写第二份实现
const _auth = (ctx: FunctionContext) => {
  const token = (ctx.headers?.authorization || '').replace('Bearer ', '')
  if (!token || !JWT_SECRET) return null
  try {
    const [h, p, s] = token.split('.')
    if (crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null
    const data = JSON.parse(Buffer.from(p, 'base64url').toString())
    return data.exp > Date.now() ? { uid: data.uid } : null
  } catch { return null }
}

function _hasSaveToken(ctx: any): boolean {
  const expected = (process.env.RENDER_SAVE_TOKEN || '').trim()
  if (!expected) return false
  const h: any = ctx.headers || {}
  const got = (h['x-save-token'] || '').toString().trim()
  return got === expected
}

export default async function (ctx: FunctionContext) {
  const { id } = ctx.query || {}

  if (!id) {
    return { error: 'missing report id' }
  }

  const ip = _extractIp(ctx)

  try {
    const res = await db.collection('reports').where({ report_id: id }).getOne()
    if (!res.data) {
      // ⚠️ 限流只拦**猜空**，命中一律照常服务。第一版把闸放在查库之前，
      // 那样同一个出口 IP 上有人在扫，就会把**真实读者一起 429** ——
      // 而 report.html 的读者走的是运营商大 NAT，同 IP 下有扫描者是常态。
      // 「拦住坏人」不能以「把用户一起锁在门外」为代价（本单的阴性对照纪律）。
      if (_missCount(ip) >= MISS_PER_HOUR_IP) {
        // 显式 429（这套后端一贯所有异常返 200，见审查 A-10，限流要能被分辨）
        try { (ctx as any).response.status(429) } catch (e) { /* 老 runtime 无 response.status */ }
        return { error: 'too_many_requests' }
      }
      _noteMiss(ip)
      return { error: 'report not found' }
    }

    // 私有报告：显式标了 is_public=false 才要身份；字段缺失＝照旧可读（存量与 report.html 零影响）
    if (res.data.is_public === false) {
      const me = _auth(ctx)
      const mine = !!me && String(res.data.uid || '') === String(me.uid)
      if (!mine && !_hasSaveToken(ctx)) {
        try { (ctx as any).response.status(403) } catch (e) { /* noop */ }
        return { error: 'forbidden' }
      }
    }

    await db.collection('reports').where({ report_id: id }).update({ views: (res.data.views || 0) + 1 })
    return {
      success: true,
      report: {
        title: res.data.title,
        content: res.data.content,
        report_type: res.data.report_type,
        card_image: res.data.card_image,
        created_at: res.data.created_at,
      }
    }
  } catch (e) {
    console.error('get_report error:', e)
    return { error: 'internal error' }
  }
}
