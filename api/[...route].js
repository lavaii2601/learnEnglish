import app, { initializeApp } from '../server/index.js'

function normalizePathFromRequestUrl(rawUrl) {
  const raw = String(rawUrl || '/').trim()
  if (!raw) return '/'

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const parsed = new URL(raw)
      return `${parsed.pathname || '/'}${parsed.search || ''}`
    } catch {
      return '/'
    }
  }

  return raw
}

export default async function handler(req, res) {
  try {
    await initializeApp()
  } catch (error) {
    const message = String(error?.message || 'Không thể khởi tạo backend trên Vercel.')
    return res.status(500).json({ message })
  }

  const currentUrl = normalizePathFromRequestUrl(req.url)
  if (!currentUrl.startsWith('/api')) {
    req.url = `/api${currentUrl.startsWith('/') ? '' : '/'}${currentUrl}`
  } else {
    req.url = currentUrl
  }

  return app(req, res)
}
