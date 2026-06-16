import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'

function loadEnvFileIfPresent() {
  const serverDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(serverDir, '..', '.env'),
    path.join(serverDir, '..', '..', '..', '.env'),
  ]
  const seen = new Set()

  for (const candidate of candidates) {
    const envPath = path.resolve(candidate)
    if (seen.has(envPath) || !fs.existsSync(envPath)) continue
    seen.add(envPath)

    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const separatorIndex = trimmed.indexOf('=')
      if (separatorIndex <= 0) continue

      const key = trimmed.slice(0, separatorIndex).trim()
      let value = trimmed.slice(separatorIndex + 1).trim()
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue

      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }

      process.env[key] = value
    }
  }
}

loadEnvFileIfPresent()

const app = express()
const PORT = Number(process.env.PORT || 3001)

app.use(cors())
app.use(express.json())

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

// Vercel can forward requests as /resource instead of /api/resource in some setups.
app.use((req, _, next) => {
  const currentUrl = normalizePathFromRequestUrl(req.url)
  if (!currentUrl.startsWith('/api')) {
    req.url = `/api${currentUrl.startsWith('/') ? '' : '/'}${currentUrl}`
  } else {
    req.url = currentUrl
  }
  next()
})

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseWriteKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
const supabaseReadKey = process.env.SUPABASE_PUBLISHABLE_KEY
  || process.env.SUPABASE_ANON_KEY
  || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const hasSecretKey = Boolean(process.env.SUPABASE_SECRET_KEY)
const hasServiceRoleKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
const hasServerWriteKey = Boolean(supabaseWriteKey)
const hasAnonKey = Boolean(process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
const hasPublishableKey = Boolean(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
const supabaseKey = supabaseWriteKey || supabaseReadKey
const shouldSeedSampleData = process.env.ENABLE_SAMPLE_SEED === 'true'
let supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  })
  : null

function createMockSupabase() {
  const tables = {
    vocabulary: [],
    mcq_questions: [],
    matching_questions: [],
    fill_blank_questions: [],
    writing_questions: [],
  }
  function deepCopy(v) { return JSON.parse(JSON.stringify(v)) }
  function from(table) {
    if (!Object.prototype.hasOwnProperty.call(tables, table)) tables[table] = []

    function select(cols, opts) {
      const filters = []
      const query = {
        eq(field, value) {
          filters.push([field, value])
          return query
        },
        order(field, { ascending = true } = {}) {
          const rows = tables[table]
            .filter((row) => filters.every(([filterField, filterValue]) => (
              String(row[filterField]) === String(filterValue)
            )))
            .sort((left, right) => {
              const comparison = Number(left[field]) - Number(right[field])
              return ascending ? comparison : -comparison
            })
          return Promise.resolve({ data: deepCopy(rows), error: null })
        },
        then(resolve, reject) {
          const rows = tables[table].filter((row) => filters.every(([filterField, filterValue]) => (
            String(row[filterField]) === String(filterValue)
          )))
          const result = opts?.head
            ? { count: rows.length, error: null }
            : { data: deepCopy(rows), error: null }
          return Promise.resolve(result).then(resolve, reject)
        },
      }
      return query
    }

    return {
      select,
      insert: async (rows) => {
        const arr = Array.isArray(rows) ? rows : [rows]
        arr.forEach((row) => {
          const id = tables[table].length ? (tables[table][tables[table].length - 1].id || tables[table].length) + 1 : 1
          tables[table].push({ id, ...deepCopy(row), created_at: new Date().toISOString() })
        })
        return { error: null }
      },
      update: (payload) => ({ eq: async (field, value) => {
        let found = false
        for (let i = 0; i < tables[table].length; i += 1) {
          if (String(tables[table][i][field]) === String(value)) {
            tables[table][i] = { ...tables[table][i], ...deepCopy(payload) }
            found = true
          }
        }
        return { error: found ? null : { message: 'not found' } }
      } }),
      delete: () => ({ eq: async (field, value) => {
        const before = tables[table].length
        for (let i = tables[table].length - 1; i >= 0; i -= 1) {
          if (String(tables[table][i][field]) === String(value)) tables[table].splice(i, 1)
        }
        return { error: before === tables[table].length ? { message: 'not found' } : null }
      } }),
    }
  }
  ;(async () => {
    await from('writing_questions').insert([
      { word: 'Sắp xếp thành câu hoàn chỉnh.', hint: 'Bắt đầu bằng chủ ngữ "She".', answer: 'She goes to school every day.', kind: 'arrange' },
    ])
  })()
  return { from }
}

if (!supabase && (process.env.NODE_ENV === 'development' || process.env.FORCE_LOCAL_MOCK === 'true')) {
  supabase = createMockSupabase()
}

let initPromise
const DATABASE_RESPONSE_CACHE_TTL_MS = 15_000
const databaseResponseCache = new Map()

function getDatabaseResponseCache(cacheKey) {
  const cached = databaseResponseCache.get(cacheKey)
  if (!cached) return null
  if (Date.now() - cached.timestamp > DATABASE_RESPONSE_CACHE_TTL_MS) {
    databaseResponseCache.delete(cacheKey)
    return null
  }
  return cached.payload
}

function setDatabaseResponseCache(cacheKey, payload) {
  databaseResponseCache.set(cacheKey, {
    timestamp: Date.now(),
    payload,
  })
}

function clearDatabaseResponseCache() {
  databaseResponseCache.clear()
}

function assertSupabaseConfigured() {
  if (supabase) return
  throw new Error('Thiếu SUPABASE_URL hoặc Supabase API key trong biến môi trường Vercel.')
}

function assertSupabaseWriteConfigured() {
  assertSupabaseConfigured()
  if (hasServerWriteKey || process.env.FORCE_LOCAL_MOCK === 'true' || process.env.NODE_ENV === 'development') return
  throw new Error('Server deploy chưa có SUPABASE_SECRET_KEY hoặc SUPABASE_SERVICE_ROLE_KEY. Các thao tác thêm/sửa/xóa trên Supabase cần secret/server key từ Vercel Supabase Integration.')
}

function toQuestionType(type) {
  if (type === 'mcq') return 'mcq'
  if (type === 'matching') return 'matching'
  if (type === 'fillBlank') return 'fillBlank'
  if (type === 'writing') return 'writing'
  if (type === 'listing') return 'listing'
  if (type === 'arrange') return 'arrange'
  return null
}

function toWritingKind(value) {
  if (value === 'arrange') return 'arrange'
  if (value === 'listing') return 'listing'
  return 'writing'
}

function extractWordFromQuestion(question) {
  const inQuotes = String(question || '').match(/['"“”](.+?)['"“”]/)
  if (inQuotes && inQuotes[1]) return inQuotes[1].trim()

  const fromPattern = String(question || '').match(/từ\s+([a-zA-Z][a-zA-Z-]*)/i)
  if (fromPattern && fromPattern[1]) return fromPattern[1].trim()

  return ''
}

function toKeywords(answer) {
  return String(answer || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .slice(0, 6)
}

function detectQuestionType(question, answer) {
  const q = String(question || '').trim().toLowerCase()
  const a = String(answer || '').trim()

  if (q.includes('___')) return 'fillBlank'

  if (
    q.includes('định nghĩa')
    || q.includes('định nghia')
    || q.includes('define')
    || q.includes('viết')
    || q.includes('write')
  ) {
    return 'writing'
  }

  if (q.includes('nghĩa của từ') || q.includes('nghia cua tu') || q.includes('mean of')) {
    return 'matching'
  }

  if (a.length <= 0) return 'mcq'
  return 'mcq'
}

function toMcqMode(mode) {
  if (mode === 'vocabulary_definition') return 'vocabulary_definition'
  return 'general'
}

function toMcqExerciseSourceMode(mode) {
  if (mode === 'vocabulary') return 'vocabulary'
  if (mode === 'question') return 'question'
  return 'mix'
}

function shuffleList(items) {
  const list = [...items]
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[list[index], list[swapIndex]] = [list[swapIndex], list[index]]
  }
  return list
}

function normalizeForCompare(text) {
  return String(text || '').trim().toLowerCase()
}

function answerProfile(answer) {
  const value = normalizeForCompare(answer)
  const words = value.split(/\s+/).filter(Boolean)
  return {
    text: value,
    wordCount: words.length,
    charCount: value.length,
    isSentenceLike: /[.!?]$/.test(value) || words.length >= 5,
    isSingleWord: words.length === 1,
    startsWith: value[0] || '',
  }
}

function answersShareShape(targetAnswer, candidateAnswer) {
  const target = answerProfile(targetAnswer)
  const candidate = answerProfile(candidateAnswer)

  return target.isSingleWord === candidate.isSingleWord
    && target.isSentenceLike === candidate.isSentenceLike
}

function questionHints(question) {
  const text = normalizeForCompare(question)
  return {
    isVocabularyDefinition: text.includes('nghĩa của từ') || text.includes('nghia cua tu') || text.includes('meaning of the word'),
    wantsGrammar: text.includes('ngữ pháp') || text.includes('grammar'),
    wantsSynonym: text.includes('đồng nghĩa') || text.includes('synonym'),
  }
}

function questionFamily(question, answer) {
  const hints = questionHints(question)
  const answerShape = answerProfile(answer)

  if (hints.isVocabularyDefinition) return 'vocabulary_definition'
  if (hints.wantsGrammar) return 'grammar_sentence'
  if (hints.wantsSynonym) return 'synonym_word'
  if (answerShape.isSentenceLike) return 'sentence_like'
  if (answerShape.isSingleWord) return 'single_word'
  return 'general'
}

function sharesQuestionFamily(targetQuestion, targetAnswer, candidateQuestion, candidateAnswer) {
  return questionFamily(targetQuestion, targetAnswer) === questionFamily(candidateQuestion, candidateAnswer)
}

function distractorScore(targetAnswer, targetQuestion, candidateAnswer, candidateQuestion) {
  const target = answerProfile(targetAnswer)
  const candidate = answerProfile(candidateAnswer)
  const targetHints = questionHints(targetQuestion)
  const candidateHints = questionHints(candidateQuestion)

  let score = 0

  if (target.isSingleWord === candidate.isSingleWord) score += 4
  if (target.isSentenceLike === candidate.isSentenceLike) score += 4

  const wordDiff = Math.abs(target.wordCount - candidate.wordCount)
  if (wordDiff === 0) score += 3
  else if (wordDiff === 1) score += 2
  else if (wordDiff <= 3) score += 1

  const charDiff = Math.abs(target.charCount - candidate.charCount)
  if (charDiff <= 2) score += 2
  else if (charDiff <= 6) score += 1

  if (target.startsWith && target.startsWith === candidate.startsWith) score += 1

  if (targetHints.wantsGrammar && candidateHints.wantsGrammar) score += 2
  if (targetHints.wantsSynonym && candidateHints.wantsSynonym) score += 2

  return score
}

function createMcqOptions(currentAnswer, allAnswerRows, currentQuestion) {
  const currentNormalized = normalizeForCompare(currentAnswer)

  const uniqueCandidates = [...new Map(
    allAnswerRows
      .filter((row) => normalizeForCompare(row.answer) !== currentNormalized)
      .map((row) => [normalizeForCompare(row.answer), row]),
  ).values()]

  const sameFamilyCandidates = uniqueCandidates.filter((row) => sharesQuestionFamily(
    currentQuestion,
    currentAnswer,
    row.question,
    row.answer,
  ))
  const sameShapeCandidates = uniqueCandidates.filter((row) => answersShareShape(currentAnswer, row.answer))
  const candidatePool = [...sameFamilyCandidates, ...sameShapeCandidates, ...uniqueCandidates]
    .filter((row, index, items) => index === items.findIndex((candidate) => normalizeForCompare(candidate.answer) === normalizeForCompare(row.answer)))

  const scoredCandidates = candidatePool
    .map((row) => ({
      answer: row.answer,
      score: distractorScore(currentAnswer, currentQuestion, row.answer, row.question),
    }))
    .sort((left, right) => right.score - left.score)

  const shortlist = scoredCandidates.slice(0, Math.min(8, scoredCandidates.length))
  const pickedDistractors = shuffleList(shortlist)
    .slice(0, 3)
    .map((item) => item.answer)

  return shuffleList([currentAnswer, ...pickedDistractors])
}

function assertNoSupabaseError(error, fallbackMessage) {
  if (!error) return
  throw new Error(error.message || fallbackMessage)
}

async function deleteRowById(table, id, fallbackMessage) {
  const deleteQuery = supabase
    .from(table)
    .delete()
    .eq('id', id)
  const { data, error } = typeof deleteQuery.select === 'function'
    ? await deleteQuery.select('id')
    : await deleteQuery

  assertNoSupabaseError(error, fallbackMessage)

  if (Array.isArray(data) && data.length === 0) {
    throw new Error(`${fallbackMessage}. Không tìm thấy dữ liệu hoặc khóa Supabase không có quyền xóa.`)
  }

  clearDatabaseResponseCache()
}

const WORD_TYPES = ['noun', 'verb', 'adjective', 'other']

function toWordType(value) {
  return WORD_TYPES.includes(value) ? value : 'other'
}

async function fetchVocabularyRows() {
  const { data, error } = await supabase
    .from('vocabulary')
    .select('id, word, definition, example, word_type, mastered_count')
    .order('id', { ascending: false })
  assertNoSupabaseError(error, 'Không thể tải danh sách từ vựng')
  return data || []
}

async function fetchMcqRows() {
  const { data, error } = await supabase
    .from('mcq_questions')
    .select('id, question, option_a, option_b, option_c, option_d, mode, answer')
    .order('id', { ascending: false })
  assertNoSupabaseError(error, 'Không thể tải câu hỏi trắc nghiệm')
  return data || []
}

async function fetchMatchingRows() {
  const { data, error } = await supabase
    .from('matching_questions')
    .select('id, word, meaning')
    .order('id', { ascending: false })
  assertNoSupabaseError(error, 'Không thể tải câu hỏi nối từ')
  return data || []
}

async function fetchFillRows() {
  const { data, error } = await supabase
    .from('fill_blank_questions')
    .select('id, sentence, answer')
    .order('id', { ascending: false })
  assertNoSupabaseError(error, 'Không thể tải câu hỏi điền chỗ trống')
  return data || []
}

async function fetchWritingRows() {
  const { data, error } = await supabase
    .from('writing_questions')
    .select('id, word, hint, keywords, answer, kind')
    .order('id', { ascending: false })
  assertNoSupabaseError(error, 'Không thể tải câu hỏi viết')
  return data || []
}

async function vocabularyCount() {
  const { count, error } = await supabase
    .from('vocabulary')
    .select('id', { count: 'exact', head: true })
  assertNoSupabaseError(error, 'Không thể đếm từ vựng')
  return count || 0
}

async function fillBlankCount() {
  const { count, error } = await supabase
    .from('fill_blank_questions')
    .select('id', { count: 'exact', head: true })
  assertNoSupabaseError(error, 'Không thể đếm câu điền chỗ trống')
  return count || 0
}

async function isVocabularyDefinition(definition) {
  const normalized = normalizeForCompare(definition)
  if (!normalized) return false

  const rows = await fetchVocabularyRows()
  return rows.some((row) => normalizeForCompare(row.definition) === normalized)
}

async function seedIfEmpty() {
  const vocabTotal = await vocabularyCount()
  const fillTotal = await fillBlankCount()

  if (vocabTotal === 0) {
    let error

    ;({ error } = await supabase.from('vocabulary').insert([
      {
        word: 'resilient',
        definition: 'Có khả năng phục hồi nhanh sau tình huống khó khăn.',
        example: 'Một học sinh kiên cường vẫn tiếp tục học sau khi mắc lỗi.',
      },
      {
        word: 'innovative',
        definition: 'Sử dụng ý tưởng mới và sáng tạo.',
        example: 'Nhóm đã xây dựng một ứng dụng học tập đầy đổi mới.',
      },
    ]))
    assertNoSupabaseError(error, 'Không thể seed từ vựng')

    ;({ error } = await supabase.from('mcq_questions').insert([
      {
        question: 'Chọn từ đồng nghĩa đúng với "rapid".',
        option_a: 'slow',
        option_b: 'quick',
        option_c: 'tiny',
        option_d: 'silent',
        answer: 'quick',
        mode: 'general',
      },
      {
        question: 'Câu nào dưới đây đúng ngữ pháp?',
        option_a: 'She go to school every day.',
        option_b: 'She goes to school every day.',
        option_c: 'She going to school every day.',
        option_d: 'She gone to school every day.',
        answer: 'She goes to school every day.',
        mode: 'general',
      },
    ]))
    assertNoSupabaseError(error, 'Không thể seed câu hỏi trắc nghiệm')

    ;({ error } = await supabase.from('matching_questions').insert([
      { word: 'diligent', meaning: 'hard-working and careful' },
      { word: 'ancient', meaning: 'very old; from long ago' },
      { word: 'thrive', meaning: 'to grow strongly and successfully' },
    ]))
    assertNoSupabaseError(error, 'Không thể seed câu hỏi nối từ')

    ;({ error } = await supabase.from('writing_questions').insert([
      {
        word: 'resilient',
        hint: 'Viết định nghĩa bằng tiếng Anh và thêm một ví dụ.',
        keywords: ['recover', 'difficult', 'strong'],
        kind: 'writing',
      },
      {
        word: 'innovative',
        hint: 'Định nghĩa từ và nhắc đến ý tưởng hoặc phương pháp mới.',
        keywords: ['new', 'idea', 'method'],
        kind: 'writing',
      },
    ]))
    assertNoSupabaseError(error, 'Không thể seed câu hỏi viết')

    ;({ error } = await supabase.from('writing_questions').insert([
      {
        word: 'Liệt kê 3 lợi ích của việc đọc sách mỗi ngày.',
        hint: 'Viết ngắn gọn, mỗi dòng một ý.',
        keywords: ['improves vocabulary', 'reduces stress', 'expands knowledge'],
        kind: 'listing',
      },
      {
        word: 'Sắp xếp thành câu hoàn chỉnh.',
        hint: 'Bắt đầu bằng chủ ngữ "She".',
        keywords: ['She goes to school every day.'],
        kind: 'arrange',
      },
    ]))
    assertNoSupabaseError(error, 'Không thể seed câu hỏi liệt kê')
  }

  if (fillTotal === 0) {
    const { error } = await supabase.from('fill_blank_questions').insert([
      {
        sentence: 'I usually ___ coffee in the morning.',
        answer: 'drink',
      },
      {
        sentence: 'If it rains, we ___ at home.',
        answer: 'will stay',
      },
    ])
    assertNoSupabaseError(error, 'Không thể seed câu điền chỗ trống')
  }
}

async function initDatabase() {
  assertSupabaseConfigured()
  if (shouldSeedSampleData) {
    await seedIfEmpty()
    clearDatabaseResponseCache()
  }
}

async function buildDatabasePayload(mcqSourceModeInput = 'mix') {
  const mcqSourceMode = toMcqExerciseSourceMode(mcqSourceModeInput)

  const [
    vocabularyRows,
    mcqRows,
    matchingRows,
    fillRows,
    writingRowsRaw,
  ] = await Promise.all([
    fetchVocabularyRows(),
    fetchMcqRows(),
    fetchMatchingRows(),
    fetchFillRows(),
    fetchWritingRows(),
  ])

  const writingRows = writingRowsRaw.filter((row) => toWritingKind(row.kind) !== 'listing')
  const listingRows = writingRowsRaw.filter((row) => toWritingKind(row.kind) === 'listing')
  const arrangeRows = writingRowsRaw.filter((row) => toWritingKind(row.kind) === 'arrange')
  const definitionRows = writingRows.filter((row) => toWritingKind(row.kind) === 'writing')

  const vocabularyAnswerRows = vocabularyRows
    .map((row) => ({
      answer: String(row.definition || '').trim(),
      question: `Nghĩa của từ "${row.word}" là gì?`,
    }))
    .filter((row) => row.answer)

  const vocabularyMcqRows = vocabularyRows.map((row) => ({
    id: `vocab-${row.id}`,
    question: `Nghĩa của từ "${row.word}" là gì?`,
    answer: String(row.definition || '').trim(),
    mode: 'vocabulary_definition',
    source: 'vocabulary',
  }))

  const questionMcqRows = mcqRows
    .map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      mode: toMcqMode(row.mode),
      source: 'question',
    }))

  const questionMcqAnswerRows = questionMcqRows.map((row) => ({
    answer: String(row.answer || '').trim(),
    question: String(row.question || '').trim(),
  }))

  const mcqVocabularyRows = vocabularyMcqRows

  const mcqQuestionRows = questionMcqRows

  const mcqExerciseRows = mcqSourceMode === 'vocabulary'
    ? mcqVocabularyRows
    : mcqSourceMode === 'question'
      ? mcqQuestionRows
      : [...mcqQuestionRows, ...mcqVocabularyRows]

  const shuffledMcqExerciseRows = shuffleList(mcqExerciseRows)

  const vocabularyExerciseAnswerRows = vocabularyAnswerRows
  const questionExerciseAnswerRows = questionMcqAnswerRows

  // Computed once per mcq_questions row and reused for mcqExercise entries with
  // source === 'question', since both use identical inputs (createMcqOptions
  // is O(n log n) per call, so this avoids doubling that cost).
  const questionMcqOptionsById = new Map(
    mcqRows.map((row) => [row.id, createMcqOptions(row.answer, questionExerciseAnswerRows, row.question)]),
  )

  return {
    vocabulary: vocabularyRows.map((row) => ({
      id: row.id,
      word: row.word,
      definition: row.definition,
      example: row.example,
      wordType: toWordType(row.word_type),
      masteredCount: row.mastered_count || 0,
    })),
    questions: {
      mcq: mcqRows.map((row) => ({
        id: row.id,
        question: row.question,
        mode: toMcqMode(row.mode),
        options: questionMcqOptionsById.get(row.id),
        answer: row.answer,
      })),
      mcqExercise: shuffledMcqExerciseRows.map((row) => ({
        id: row.id,
        question: row.question,
        mode: row.mode,
        source: row.source,
        options:
          row.source === 'vocabulary'
            ? createMcqOptions(row.answer, vocabularyExerciseAnswerRows, row.question)
            : questionMcqOptionsById.get(row.id),
        answer: row.answer,
      })),
      matching: matchingRows,
      fillBlank: fillRows,
      writing: definitionRows.map((row) => ({
        id: row.id,
        word: row.word,
        hint: row.hint,
        keywords: Array.isArray(row.keywords) ? row.keywords : [],
      })),
      listing: listingRows.map((row) => ({
        id: row.id,
        prompt: row.word,
        hint: row.hint,
        answers: Array.isArray(row.keywords) ? row.keywords : [],
      })),
      arrange: arrangeRows.map((row) => ({
        id: row.id,
        prompt: row.word,
        hint: row.hint,
        answer: String(row.answer || (Array.isArray(row.keywords) ? row.keywords[0] : '') || '').trim(),
      })),
    },
  }
}

app.get('/api/health', (_, res) => {
  res.json({
    ok: true,
    supabaseConfigured: Boolean(supabaseUrl && supabaseKey),
    hasSecretKey,
    hasServiceRoleKey,
    hasServerWriteKey,
    hasAnonKey,
    hasPublishableKey,
    writeReady: Boolean(supabaseUrl && hasServerWriteKey),
    nodeEnv: process.env.NODE_ENV || '',
  })
})

app.use('/api', (req, _, next) => {
  try {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      assertSupabaseWriteConfigured()
    }
    next()
  } catch (error) {
    next(error)
  }
})

app.get('/api/database', async (req, res, next) => {
  try {
    const mcqMode = toMcqExerciseSourceMode(req.query.mcqMode)
    const wantsFresh = String(req.query.fresh || '') === '1'

    if (!wantsFresh) {
      const cachedPayload = getDatabaseResponseCache(mcqMode)
      if (cachedPayload) {
        res.set('x-cache-status', 'HIT')
        res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120')
        return res.json(cachedPayload)
      }
    }

    const payload = await buildDatabasePayload(mcqMode)

    if (wantsFresh) {
      res.set('Cache-Control', 'no-store')
    } else {
      setDatabaseResponseCache(mcqMode, payload)
      res.set('x-cache-status', 'MISS')
      res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120')
    }
    res.json(payload)
  } catch (error) {
    next(error)
  }
})

app.post('/api/vocabulary', async (req, res, next) => {
  try {
    const word = String(req.body.word || '').trim()
    const definition = String(req.body.definition || '').trim()
    const example = String(req.body.example || '').trim()
    const wordType = toWordType(req.body.wordType)

    if (!word || !definition) {
      return res.status(400).json({ message: 'Cần có đầy đủ từ và định nghĩa' })
    }

    const { error } = await supabase.from('vocabulary').insert([{ word, definition, example, word_type: wordType }])
    assertNoSupabaseError(error, 'Không thể thêm từ vựng')
    clearDatabaseResponseCache()

    return res.status(201).json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.put('/api/vocabulary/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const word = String(req.body.word || '').trim()
    const definition = String(req.body.definition || '').trim()
    const example = String(req.body.example || '').trim()
    const wordType = toWordType(req.body.wordType)

    if (!id || !word || !definition) {
      return res.status(400).json({ message: 'Dữ liệu gửi lên không hợp lệ' })
    }

    const { error } = await supabase
      .from('vocabulary')
      .update({ word, definition, example, word_type: wordType })
      .eq('id', id)
    assertNoSupabaseError(error, 'Không thể cập nhật từ vựng')
    clearDatabaseResponseCache()

    return res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/vocabulary/:id/progress', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ' })

    const correct = Boolean(req.body.correct)

    const { data, error: selectError } = await supabase
      .from('vocabulary')
      .select('mastered_count')
      .eq('id', id)
    assertNoSupabaseError(selectError, 'Không thể tải dữ liệu từ vựng')

    const current = data?.[0]?.mastered_count || 0
    const masteredCount = Math.max(0, current + (correct ? 1 : -1))

    const { error } = await supabase
      .from('vocabulary')
      .update({ mastered_count: masteredCount })
      .eq('id', id)
    assertNoSupabaseError(error, 'Không thể cập nhật tiến độ từ vựng')
    clearDatabaseResponseCache()

    return res.json({ ok: true, masteredCount })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/vocabulary/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ' })

    await deleteRowById('vocabulary', id, 'Không thể xóa từ vựng')

    return res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/vocabulary/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ' })

    await deleteRowById('vocabulary', id, 'Không thể xóa từ vựng')

    return res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/questions', async (req, res, next) => {
  try {
    const type = toQuestionType(req.body.type || 'mcq')

    if (type === 'mcq') {
      const question = String(req.body.question || '').trim()
      const answer = String(req.body.answer || '').trim()
      if (!question || !answer) {
        return res.status(400).json({ message: 'Dữ liệu câu hỏi trắc nghiệm không hợp lệ' })
      }

      const { error } = await supabase.from('mcq_questions').insert([
        {
          question,
          option_a: '',
          option_b: '',
          option_c: '',
          option_d: '',
          mode: 'general',
          answer,
        },
      ])
      assertNoSupabaseError(error, 'Không thể thêm câu hỏi trắc nghiệm')
    }

    if (type === 'matching') {
      const word = String(req.body.word || '').trim()
      const meaning = String(req.body.meaning || '').trim()

      if (!word || !meaning) {
        return res.status(400).json({ message: 'Dữ liệu bài nối từ không hợp lệ' })
      }

      const { error } = await supabase.from('matching_questions').insert([
        {
          word,
          meaning,
        },
      ])
      assertNoSupabaseError(error, 'Không thể thêm câu hỏi nối từ')
    }

    if (type === 'writing') {
      const word = String(req.body.word || '').trim()
      const hint = String(req.body.hint || '').trim()
      const keywords = Array.isArray(req.body.keywords)
        ? req.body.keywords
          .map((line) => String(line || '').trim())
          .filter(Boolean)
        : []

      if (!word || !hint || !keywords.length) {
        return res.status(400).json({ message: 'Dữ liệu bài viết không hợp lệ' })
      }

      const { error } = await supabase.from('writing_questions').insert([
        {
          word,
          hint,
          keywords,
          kind: 'writing',
        },
      ])
      assertNoSupabaseError(error, 'Không thể thêm đề viết')
    }

    if (type === 'listing') {
      const prompt = String(req.body.prompt || '').trim()
      const hint = String(req.body.hint || '').trim()
      const answers = Array.isArray(req.body.answers)
        ? req.body.answers
          .map((line) => String(line || '').trim())
          .filter(Boolean)
        : []

      if (!prompt || !answers.length) {
        return res.status(400).json({ message: 'Dữ liệu câu hỏi liệt kê không hợp lệ' })
      }

      const { error } = await supabase.from('writing_questions').insert([
        {
          word: prompt,
          hint,
          keywords: answers,
          kind: 'listing',
        },
      ])
      assertNoSupabaseError(error, 'Không thể thêm câu hỏi liệt kê')
    }

    if (type === 'arrange') {
      const prompt = String(req.body.prompt || '').trim()
      const hint = String(req.body.hint || '').trim()
      const answer = String(req.body.answer || '').trim()

      if (!prompt || !answer) {
        return res.status(400).json({ message: 'Dữ liệu câu hỏi sắp xếp không hợp lệ' })
      }

      const { error } = await supabase.from('writing_questions').insert([
        {
          word: prompt,
          hint,
          answer,
          kind: 'arrange',
        },
      ])
      assertNoSupabaseError(error, 'Không thể thêm câu hỏi sắp xếp')
    }

    if (!type) {
      return res.status(400).json({ message: 'Loại câu hỏi không hợp lệ' })
    }

    clearDatabaseResponseCache()

    return res.status(201).json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.put('/api/questions/:type/:id', async (req, res, next) => {
  try {
    const type = toQuestionType(req.params.type)
    const id = Number(req.params.id)

    if (!type || !id) return res.status(400).json({ message: 'Tham số không hợp lệ' })

    if (type === 'mcq') {
      const mode = toMcqMode(req.body.mode)
      const question = String(req.body.question || '').trim()
      const answer = String(req.body.answer || '').trim()
      if (!question || !answer) {
        return res.status(400).json({ message: 'Dữ liệu câu hỏi trắc nghiệm không hợp lệ' })
      }

      if (mode === 'vocabulary_definition') {
        const vocabHit = await isVocabularyDefinition(answer)
        if (!vocabHit) {
          return res.status(400).json({
            message: 'Với loại từ vựng-định nghĩa, đáp án đúng phải là một định nghĩa đã có trong kho từ vựng.',
          })
        }
      }

      const { error } = await supabase
        .from('mcq_questions')
        .update({
          question,
          option_a: '',
          option_b: '',
          option_c: '',
          option_d: '',
          mode,
          answer,
        })
        .eq('id', id)
      assertNoSupabaseError(error, 'Không thể cập nhật câu hỏi trắc nghiệm')
      clearDatabaseResponseCache()
    }

    if (type === 'matching') {
      const word = String(req.body.word || '').trim()
      const meaning = String(req.body.meaning || '').trim()
      if (!word || !meaning) {
        return res.status(400).json({ message: 'Dữ liệu bài nối từ không hợp lệ' })
      }
      const { error } = await supabase
        .from('matching_questions')
        .update({ word, meaning })
        .eq('id', id)
      assertNoSupabaseError(error, 'Không thể cập nhật câu hỏi nối từ')
      clearDatabaseResponseCache()
    }

    if (type === 'fillBlank') {
      const sentence = String(req.body.sentence || '').trim()
      const answer = String(req.body.answer || '').trim()
      if (!sentence || !answer) {
        return res.status(400).json({ message: 'Dữ liệu bài điền chỗ trống không hợp lệ' })
      }
      const { error } = await supabase
        .from('fill_blank_questions')
        .update({ sentence, answer })
        .eq('id', id)
      assertNoSupabaseError(error, 'Không thể cập nhật câu hỏi điền chỗ trống')
      clearDatabaseResponseCache()
    }

    if (type === 'writing') {
      const word = String(req.body.word || '').trim()
      const hint = String(req.body.hint || '').trim()
      const keywords = Array.isArray(req.body.keywords) ? req.body.keywords : []
      if (!word || !hint) {
        return res.status(400).json({ message: 'Dữ liệu bài viết không hợp lệ' })
      }
      const { error } = await supabase
        .from('writing_questions')
        .update({ word, hint, keywords, kind: 'writing' })
        .eq('id', id)
      assertNoSupabaseError(error, 'Không thể cập nhật câu hỏi viết')
      clearDatabaseResponseCache()
    }

    if (type === 'listing') {
      const prompt = String(req.body.prompt || '').trim()
      const hint = String(req.body.hint || '').trim()
      const answers = Array.isArray(req.body.answers)
        ? req.body.answers
          .map((line) => String(line || '').trim())
          .filter(Boolean)
        : []

      if (!prompt || !answers.length) {
        return res.status(400).json({ message: 'Dữ liệu câu hỏi liệt kê không hợp lệ' })
      }

      const { error } = await supabase
        .from('writing_questions')
        .update({ word: prompt, hint, keywords: answers, kind: 'listing' })
        .eq('id', id)
      assertNoSupabaseError(error, 'Không thể cập nhật câu hỏi liệt kê')
      clearDatabaseResponseCache()
    }

    if (type === 'arrange') {
      const prompt = String(req.body.prompt || '').trim()
      const hint = String(req.body.hint || '').trim()
      const answer = String(req.body.answer || '').trim()

      if (!prompt || !answer) {
        return res.status(400).json({ message: 'Dữ liệu câu hỏi sắp xếp không hợp lệ' })
      }

      const { error } = await supabase
        .from('writing_questions')
        .update({ word: prompt, hint, answer, kind: 'arrange' })
        .eq('id', id)
      assertNoSupabaseError(error, 'Không thể cập nhật câu hỏi sắp xếp')
      clearDatabaseResponseCache()
    }

    return res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/questions/:type/:id', async (req, res, next) => {
  try {
    const type = toQuestionType(req.params.type)
    const id = Number(req.params.id)

    if (!type || !id) return res.status(400).json({ message: 'Tham số không hợp lệ' })

    if (type === 'mcq') {
      await deleteRowById('mcq_questions', id, 'Không thể xóa câu hỏi trắc nghiệm')
    }

    if (type === 'matching') {
      await deleteRowById('matching_questions', id, 'Không thể xóa câu hỏi nối từ')
    }

    if (type === 'fillBlank') {
      await deleteRowById('fill_blank_questions', id, 'Không thể xóa câu hỏi điền chỗ trống')
    }

    if (type === 'writing') {
      await deleteRowById('writing_questions', id, 'Không thể xóa câu hỏi viết')
    }

    if (type === 'listing') {
      await deleteRowById('writing_questions', id, 'Không thể xóa câu hỏi liệt kê')
    }

    if (type === 'arrange') {
      await deleteRowById('writing_questions', id, 'Không thể xóa câu hỏi sắp xếp')
    }

    return res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/questions/:type/:id/delete', async (req, res, next) => {
  try {
    const type = toQuestionType(req.params.type)
    const id = Number(req.params.id)

    if (!type || !id) return res.status(400).json({ message: 'Tham số không hợp lệ' })

    if (type === 'mcq') {
      await deleteRowById('mcq_questions', id, 'Không thể xóa câu hỏi trắc nghiệm')
    }

    if (type === 'matching') {
      await deleteRowById('matching_questions', id, 'Không thể xóa câu hỏi nối từ')
    }

    if (type === 'fillBlank') {
      await deleteRowById('fill_blank_questions', id, 'Không thể xóa câu hỏi điền chỗ trống')
    }

    if (type === 'writing') {
      await deleteRowById('writing_questions', id, 'Không thể xóa câu hỏi viết')
    }

    if (type === 'listing') {
      await deleteRowById('writing_questions', id, 'Không thể xóa câu hỏi liệt kê')
    }

    if (type === 'arrange') {
      await deleteRowById('writing_questions', id, 'Không thể xóa câu hỏi sắp xếp')
    }

    return res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.use((req, res) => {
  res.status(404).json({
    message: `Không tìm thấy endpoint API: ${req.method} ${req.originalUrl}`,
  })
})

app.use((error, _, res, __) => {
  console.error(error)
  const message = String(error?.message || '')
  if (message.includes('relation') || message.includes('does not exist')) {
    return res.status(500).json({
      message: 'Chưa có bảng Supabase. Hãy chạy SQL trong file supabase/schema.sql trước.',
    })
  }
  return res.status(500).json({ message: message || 'Lỗi máy chủ nội bộ' })
})

async function start() {
  await initDatabase()
  app.listen(PORT, () => {
    console.log(`Máy chủ API đang chạy tại http://localhost:${PORT}`)
  })
}

export async function initializeApp() {
  if (!initPromise) {
    initPromise = initDatabase().catch((error) => {
      initPromise = null
      throw error
    })
  }

  await initPromise
}

export default app

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false

if (isDirectRun) {
  start().catch((error) => {
    console.error('Không thể khởi động máy chủ API:', error)
    process.exit(1)
  })
}
