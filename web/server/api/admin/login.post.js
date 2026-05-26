export default defineEventHandler(async (event) => {
  const { key } = await readBody(event)

  try {
    const claims = verifyToken(key)
    if (claims.role !== 'admin') throw new Error('not admin')
  } catch {
    throw createError({ statusCode: 401, statusMessage: 'Invalid token' })
  }

  setCookie(event, 'admin_session', key, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 60 * 60 * 24,
    path: '/',
  })

  return { ok: true }
})
