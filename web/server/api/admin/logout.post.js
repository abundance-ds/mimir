export default defineEventHandler((event) => {
  deleteCookie(event, 'admin_session', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
  })

  return { ok: true }
})
