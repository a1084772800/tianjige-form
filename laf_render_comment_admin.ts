import cloud from '@lafjs/cloud'

// 留言管理（X-Save-Token，与 save_render 同一把 RENDER_SAVE_TOKEN，0904）：
//   {op:'pull', since:<ms>}            → since 之后的留言（含 ip/ua 供审计），升序 ≤50
//   {op:'reply', comment_id, reply}    → 写回复（页面留言区随即可见）
const db = cloud.database()
const _ = db.command

export default async function (ctx: FunctionContext) {
  const expected = (process.env.RENDER_SAVE_TOKEN || '').trim()
  if (!expected) return { error: 'server_misconfigured: RENDER_SAVE_TOKEN unset' }
  const h: any = ctx.headers || {}
  const got = (h['x-save-token'] || h['X-Save-Token'] || '').toString().trim()
  if (got !== expected) return { error: 'unauthorized' }
  const b: any = ctx.body || {}
  if (b.op === 'pull') {
    const since = Number(b.since || 0)
    const res = await db.collection('render_comments').where({ created_at: _.gt(since) })
      .orderBy('created_at', 'asc').limit(50).get()
    return { success: true, comments: (res.data || []).map((c: any) => ({
      id: c.cid, render_id: c.render_id, nick: c.nick || '', text: c.text, ip: c.ip || '', ua: c.ua || '',
      created_at: c.created_at, status: c.status || 'new', reply: c.reply || '',
    })) }
  }
  if (b.op === 'reply') {
    const cid = String(b.comment_id || '').trim()
    const reply = String(b.reply || '').trim()
    if (!cid || !reply || reply.length > 4000) return { error: 'bad_request' }
    const r = await db.collection('render_comments').where({ cid }).update({ reply, replied_at: Date.now(), status: 'replied' })
    return { success: true, updated: r.updated || 0 }
  }
  return { error: 'bad_op' }
}
