import cloud from '@lafjs/cloud'

const db = cloud.database()

// 256KB cap：命理报告内容（含八字 / 紫微 / 解梦 markdown），上限给足
const MAX_CONTENT_BYTES = 256 * 1024

export default async function (ctx: FunctionContext) {
  // 1. Token 鉴权（与 save_render 同一 RENDER_SAVE_TOKEN）
  const expected = (process.env.RENDER_SAVE_TOKEN || '').trim()
  if (!expected) {
    return { error: 'server_misconfigured: RENDER_SAVE_TOKEN unset' }
  }
  const headers: any = ctx.headers || {}
  const got = (headers['x-save-token'] || headers['X-Save-Token'] || '').toString().trim()
  if (got !== expected) {
    return { error: 'unauthorized' }
  }

  const body = ctx.body || {}
  const { report_id, uid, title, content, report_type, card_image, created_at } = body

  if (!report_id || !content) {
    return { error: 'missing report_id or content' }
  }

  // 2. Size guard：内容字段 ≤ 256KB；card_image base64 也算入
  try {
    const contentBytes = Buffer.byteLength(typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
    const cardBytes = card_image ? Buffer.byteLength(String(card_image), 'utf8') : 0
    const total = contentBytes + cardBytes
    if (total > MAX_CONTENT_BYTES) {
      return { error: 'content_too_large', actual: total, max: MAX_CONTENT_BYTES }
    }
  } catch (e) {
    return { error: 'invalid_body' }
  }

  try {
    await db.collection('reports').add({
      report_id,
      uid: uid || '',
      title: title || '命理报告',
      content,
      report_type: report_type || 'bazi',
      card_image: card_image || '',
      created_at: created_at || Date.now(),
      views: 0,
    })
    return { success: true, report_id }
  } catch (e) {
    console.error('save_report error:', e)
    return { error: 'internal error' }
  }
}
