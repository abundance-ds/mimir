export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/admin')) return
  if (path === '/api/admin/login') return

  const cookie = getCookie(event, 'admin_session')
  if (!cookie) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  try {
    const claims = verifyToken(cookie)
    if (claims.role !== 'admin') throw new Error('not admin')
  } catch {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
})
