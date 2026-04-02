import cloud from '@lafjs/cloud'

const db = cloud.database()

export default async function (ctx: FunctionContext) {
  const body = ctx.body || {}
  const { report_id, uid, title, content, report_type, card_image, created_at } = body

  if (!report_id || !content) {
    return { error: 'missing report_id or content' }
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
