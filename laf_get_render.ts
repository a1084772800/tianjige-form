import cloud from '@lafjs/cloud'

const db = cloud.database()

// ── 0913 安全修（审查 A-03）───────────────────────────────────────────────────
// 现场实锤：render_id 是 `fund-flow-timeline-2026-09-09` 这种人类可读 slug，**改日期就能猜到**
// （2026-09-09 → 202812 字节、2026-09-08 → 201699 字节，都不是自己的项目）。renders 里装的是
// **别的项目 / 别的客户**的交付页（荐股、资金流分析），共 270 条 / 34.9MB。不需要账号、不需要
// id 泄漏，按命名规律遍历就能整批拉走 —— 直接踩「客户数据隔离」底线。
//
// 这一版做两件**不破坏任何已发出链接**的事：
//   ① is_public === false 的页面要令牌才给（默认值缺失＝照旧公开，所以存量 270 条一条不受影响）。
//      这是给 owner 的开关：以后哪一页敏感就标一下，不必等改命名规则。
//   ② 同一 IP 一小时内**猜空**次数设上限，超限后再猜空一律 429。
//      只卡 miss、**命中永远照常返回** —— 真实读者打开的是发给他的那条真链接，miss 恒为 0，
//      所以这条闸对正常访问零影响（也就不会出现「为了防爬把自己人也 429 了」这种自伤）；
//      而按日期遍历 slug 的人必然大量猜空，30 次之后就撞墙。
//      这是提高遍历成本，不是消灭遍历：命中密集的 slug 家族仍能被逐个撞到。
//
// ⚠️ 没做、也不该由本单擅自做的：**新建 render 一律 `slug-<8位随机>`**。那才是根治，
//    但它改的是交付页命名规则、涉及其他项目既有工作流（render_tool 的 versions/restore/url
//    都按 render_id 索引），按审查报告原话「需 owner 点头」。本单只做不需要拍板的部分。
//
// ⚠️ 计数器是**进程内**的（同 laf_save_profile.ts 那套）：laf 多实例时每个实例各记一份，
//    上限实际会放宽到「实例数 × 上限」。刻意取舍——不为限流去写生产库。
const MISS_PER_HOUR_IP = 30

const _missTracker: Map<string, number[]> = (cloud as any)._renderMissTracker || new Map()
;(cloud as any)._renderMissTracker = _missTracker

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

function _hasSaveToken(ctx: any): boolean {
  const expected = (process.env.RENDER_SAVE_TOKEN || '').trim()
  if (!expected) return false
  const h: any = ctx.headers || {}
  const q: any = ctx.query || {}
  const got = (h['x-save-token'] || q.token || '').toString().trim()
  return got === expected
}

export default async function (ctx: FunctionContext) {
  const { id } = ctx.query || {}

  if (!id) {
    return { error: 'missing render id' }
  }

  const ip = _extractIp(ctx)
  const exempt = _hasSaveToken(ctx)

  try {
    const res = await db.collection('renders').where({ render_id: id }).getOne()
    if (!res.data) {
      // 猜空才计数、也只有猜空会被拦。命中的请求一律照常服务，所以这条闸
      // **不可能把真实读者挡在门外**（他手上的链接是命中的）。
      if (!exempt && _missCount(ip) >= MISS_PER_HOUR_IP) {
        // 显式 429：这套后端一贯所有异常返 200（审查 A-10），限流要能被分辨出来。
        try { (ctx as any).response.status(429) } catch (e) { /* 老 runtime 无 response.status */ }
        return { error: 'too_many_requests' }
      }
      if (!exempt) _noteMiss(ip)
      return { error: 'not found' }
    }

    // 私有页：显式标了 is_public=false 才要令牌；字段缺失＝照旧公开（存量 270 条零影响）
    if (res.data.is_public === false && !exempt) {
      try { (ctx as any).response.status(403) } catch (e) { /* noop */ }
      return { error: 'forbidden' }
    }

    // 检查过期
    if (res.data.expires_at && res.data.expires_at < Date.now()) {
      return { error: 'expired' }
    }

    // 浏览量+1
    await db.collection('renders').where({ render_id: id }).update({
      views: (res.data.views || 0) + 1,
    })

    return {
      success: true,
      title: res.data.title,
      html: res.data.html,
      created_at: res.data.created_at,
    }
  } catch (e) {
    console.error('get_render error:', e)
    return { error: 'internal error' }
  }
}
