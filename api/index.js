import app, { initializeApp } from '../server/index.js'

export default async function handler(req, res) {
  try {
    await initializeApp()
  } catch (error) {
    const message = String(error?.message || 'Không thể khởi tạo backend trên Vercel.')
    return res.status(500).json({ message })
  }

  const currentUrl = String(req.url || '/').trim()
  if (!currentUrl.startsWith('/api')) {
    req.url = `/api${currentUrl.startsWith('/') ? '' : '/'}${currentUrl}`
  }

  return app(req, res)
}
