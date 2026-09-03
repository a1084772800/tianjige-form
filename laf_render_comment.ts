import cloud from '@lafjs/cloud'

// 交付页留言（公开 POST，0904）：页面上的留言框 → 这里 → render_comments 集合 → 本机 poller 拉进 inbox。
// 闸：render_id 形态 + 页面必须真存在（renders 集合）；正文 1–2000；同 IP 每小时 ≤10；同页每天 ≤200。
const db = cloud.database()
const _ = db.command
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function rid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

export default async function (ctx: FunctionContext) {
  const b: any = ctx.body || {}
  const render_id = String(b.render_id || '').trim()
  const text = String(b.text || '').replace(/\r/g, '').trim()
  const nick = String(b.nick || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!ID_RE.test(render_id)) return { error: 'bad_render_id' }
  if (!text || text.length > 2000) return { error: 'bad_text' }
  const page = await db.collection('renders').where({ render_id }).getOne()
  if (!page.data) return { error: 'page_not_found' }
  const h: any = ctx.headers || {}
  const ip = String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim().slice(0, 64)
  const ua = String(h['user-agent'] || '').slice(0, 200)
  const now = Date.now()
  const byIp = await db.collection('render_comments').where({ ip, created_at: _.gt(now - 3600 * 1000) }).count()
  if ((byIp.total || 0) >= 10) return { error: 'rate_limited' }
  const byPage = await db.collection('render_comments').where({ render_id, created_at: _.gt(now - 86400 * 1000) }).count()
  if ((byPage.total || 0) >= 200) return { error: 'page_quota' }
  const cid = rid()
  await db.collection('render_comments').add({
    cid, render_id, text, nick, ip, ua, created_at: now, status: 'new', reply: '', replied_at: 0,
  })
  return { success: true, comment_id: cid, created_at: now }
}
