import cloud from '@lafjs/cloud'

// 交付页留言区读取（公开 GET ?id=<render_id>，0904）：只回显留言与我方回复，不含 IP/UA。
const db = cloud.database()
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export default async function (ctx: FunctionContext) {
  const id = String((ctx.query || {}).id || '').trim()
  if (!ID_RE.test(id)) return { error: 'bad_render_id' }
  const res = await db.collection('render_comments').where({ render_id: id })
    .orderBy('created_at', 'asc').limit(100).get()
  const comments = (res.data || []).map((c: any) => ({
    id: c.cid, nick: c.nick || '', text: c.text, created_at: c.created_at,
    reply: c.reply || '', replied_at: c.replied_at || 0,
  }))
  return { success: true, comments }
}
