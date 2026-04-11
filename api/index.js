import app, { initializeApp } from '../server/index.js'

export default async function handler(req, res) {
  await initializeApp()

  const currentUrl = String(req.url || '/').trim()
  if (!currentUrl.startsWith('/api')) {
    req.url = `/api${currentUrl.startsWith('/') ? '' : '/'}${currentUrl}`
  }

  return app(req, res)
}
