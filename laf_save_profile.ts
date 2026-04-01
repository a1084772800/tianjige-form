import cloud from '@lafjs/cloud'

const db = cloud.database()

export default async function (ctx: FunctionContext) {
  const body = ctx.body || {}
  const { uid } = body

  if (!uid) {
    return { error: 'missing uid' }
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
