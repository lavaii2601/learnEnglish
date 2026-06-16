const API_BASE = import.meta.env.VITE_API_URL
  || (import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : '')

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])
const REQUEST_TIMEOUT_MS = 12_000

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

async function request(path, options = {}) {
  const { retry = 0, ...fetchOptions } = options
  let response

  for (let attempt = 0; attempt <= retry; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      response = await fetch(`${API_BASE}${path}`, {
        headers: {
          'Content-Type': 'application/json',
          ...(fetchOptions.headers || {}),
        },
        signal: controller.signal,
        ...fetchOptions,
      })
    } catch (error) {
      window.clearTimeout(timeoutId)
      if (error?.name === 'AbortError') {
        if (attempt >= retry) throw new Error('Kết nối máy chủ quá lâu, vui lòng thử lại.')
        await wait(500 * (attempt + 1))
        continue
      }
      if (attempt >= retry) throw error
      await wait(500 * (attempt + 1))
      continue
    } finally {
      window.clearTimeout(timeoutId)
    }

    if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= retry) break
    await wait(500 * (attempt + 1))
  }

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

function isRetryableDeleteFallbackError(error) {
  const message = String(error?.message || '')
  return /HTTP\s+(403|404|405|501)/i.test(message)
    || /Unexpected token|JSON|Failed to fetch|NetworkError/i.test(message)
}

async function requestWithDeleteFallback(path, fallbackPath) {
  try {
    return await request(fallbackPath, { method: 'POST' })
  } catch (error) {
    if (!isRetryableDeleteFallbackError(error)) throw error
    return request(path, { method: 'DELETE' })
  }
}

async function requestWithFlatDeleteFallback(path, fallbackPath, flatPath, payload) {
  try {
    return await request(flatPath, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  } catch (error) {
    if (!isRetryableDeleteFallbackError(error)) throw error
    return requestWithDeleteFallback(path, fallbackPath)
  }
}

async function requestWithUpdateFallback(path, fallbackPath, payload) {
  const body = JSON.stringify(payload)
  try {
    return await request(fallbackPath, { method: 'POST', body })
  } catch (error) {
    if (!isRetryableDeleteFallbackError(error)) throw error
    return request(path, { method: 'PUT', body })
  }
}

async function requestWithFlatUpdateFallback(path, fallbackPath, flatPath, payload) {
  try {
    return await request(flatPath, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  } catch (error) {
    if (!isRetryableDeleteFallbackError(error)) throw error
    return requestWithUpdateFallback(path, fallbackPath, payload.payload || payload)
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
  return request(`/api/database${query ? `?${query}` : ''}`, { retry: 2 })
}

export function createVocabulary(payload) {
  return request('/api/vocabulary', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateVocabulary(id, payload) {
  const safeId = encodeURIComponent(String(id))
  return requestWithFlatUpdateFallback(
    `/api/vocabulary/${safeId}`,
    `/api/vocabulary/${safeId}/update`,
    '/api/vocabulary-update',
    { id, payload },
  )
}

export function updateVocabularyProgress(id, correct) {
  return request(`/api/vocabulary/${encodeURIComponent(String(id))}/progress`, {
    method: 'POST',
    body: JSON.stringify({ correct }),
  })
}

export function deleteVocabulary(id) {
  const safeId = encodeURIComponent(String(id))
  return requestWithFlatDeleteFallback(
    `/api/vocabulary/${safeId}`,
    `/api/vocabulary/${safeId}/delete`,
    '/api/vocabulary-delete',
    { id },
  )
}

export function createQuestion(payload) {
  return request('/api/questions', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateQuestion(type, id, payload) {
  const safeType = encodeURIComponent(String(type))
  const safeId = encodeURIComponent(String(id))
  return requestWithFlatUpdateFallback(
    `/api/questions/${safeType}/${safeId}`,
    `/api/questions/${safeType}/${safeId}/update`,
    '/api/question-update',
    { type, id, payload },
  )
}

export function deleteQuestion(type, id) {
  const safeType = encodeURIComponent(String(type))
  const safeId = encodeURIComponent(String(id))
  return requestWithFlatDeleteFallback(
    `/api/questions/${safeType}/${safeId}`,
    `/api/questions/${safeType}/${safeId}/delete`,
    '/api/question-delete',
    { type, id },
  )
}
