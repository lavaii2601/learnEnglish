const API_BASE = import.meta.env.VITE_API_URL
  || (import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : '')

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })

  if (!response.ok) {
    let message = `Yêu cầu thất bại (HTTP ${response.status})`
    try {
      const payload = await response.json()
      message = payload.message || message
    } catch {
      // Keep fallback error message.
    }
    throw new Error(message)
  }

  return response.json()
}

async function requestWithDeleteFallback(path, fallbackPath) {
  try {
    return await request(path, { method: 'DELETE' })
  } catch (error) {
    const is404 = /HTTP\s+404/i.test(String(error?.message || ''))
    if (!is404) throw error
    return request(fallbackPath, { method: 'POST' })
  }
}

export function fetchDatabase(options = {}) {
  const params = new URLSearchParams()
  if (options.mcqMode) {
    params.set('mcqMode', options.mcqMode)
  }
  if (options.fresh) {
    params.set('fresh', '1')
  }
  const query = params.toString()
  return request(`/api/database${query ? `?${query}` : ''}`)
}

export function createVocabulary(payload) {
  return request('/api/vocabulary', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateVocabulary(id, payload) {
  return request(`/api/vocabulary/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function deleteVocabulary(id) {
  return requestWithDeleteFallback(
    `/api/vocabulary/${id}`,
    `/api/vocabulary/${id}/delete`,
  )
}

export function createQuestion(payload) {
  return request('/api/questions', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateQuestion(type, id, payload) {
  return request(`/api/questions/${type}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function deleteQuestion(type, id) {
  return requestWithDeleteFallback(
    `/api/questions/${type}/${id}`,
    `/api/questions/${type}/${id}/delete`,
  )
}
