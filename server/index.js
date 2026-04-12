import cors from 'cors'
import express from 'express'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'

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

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
const shouldSeedSampleData = process.env.ENABLE_SAMPLE_SEED === 'true'
const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  })
  : null

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
  throw new Error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY trong biến môi trường.')
}

function toQuestionType(type) {
  if (type === 'mcq') return 'mcq'
  if (type === 'matching') return 'matching'
  if (type === 'fillBlank') return 'fillBlank'
  if (type === 'writing') return 'writing'
  if (type === 'listing') return 'listing'
  return null
}

function toWritingKind(value) {
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

async function fetchVocabularyRows() {
  const { data, error } = await supabase
    .from('vocabulary')
    .select('id, word, definition, example')
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
    .select('id, word, hint, keywords, kind')
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

  const vocabularyMcqAnswerRows = mcqRows
    .filter((row) => toMcqMode(row.mode) === 'vocabulary_definition')
    .map((row) => ({
      answer: String(row.answer || '').trim(),
      question: String(row.question || '').trim(),
    }))
    .filter((row) => row.answer)

  const questionMcqRows = mcqRows
    .filter((row) => toMcqMode(row.mode) !== 'vocabulary_definition')
    .map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      mode: 'general',
      source: 'question',
    }))

  const questionMcqAnswerRows = questionMcqRows.map((row) => ({
    answer: String(row.answer || '').trim(),
    question: String(row.question || '').trim(),
  }))

  const mcqVocabularyRows = [
    ...vocabularyMcqRows,
    ...mcqRows
      .filter((row) => toMcqMode(row.mode) === 'vocabulary_definition')
      .map((row) => ({
        id: row.id,
        question: row.question,
        answer: String(row.answer || '').trim(),
        mode: 'vocabulary_definition',
        source: 'vocabulary',
      })),
  ]

  const mcqQuestionRows = questionMcqRows

  const mcqExerciseRows = mcqSourceMode === 'vocabulary'
    ? mcqVocabularyRows
    : mcqSourceMode === 'question'
      ? mcqQuestionRows
      : [...mcqQuestionRows, ...mcqVocabularyRows]

  const shuffledMcqExerciseRows = shuffleList(mcqExerciseRows)

  const vocabularyExerciseAnswerRows = [...vocabularyAnswerRows, ...vocabularyMcqAnswerRows]
  const questionExerciseAnswerRows = questionMcqAnswerRows

  return {
    vocabulary: vocabularyRows,
    questions: {
      mcq: mcqRows.map((row) => ({
        id: row.id,
        question: row.question,
        mode: toMcqMode(row.mode),
        options:
          toMcqMode(row.mode) === 'vocabulary_definition'
            ? createMcqOptions(row.answer, vocabularyExerciseAnswerRows, row.question)
            : createMcqOptions(row.answer, questionExerciseAnswerRows, row.question),
        answer: row.answer,
      })),
      mcqExercise: shuffledMcqExerciseRows.map((row) => ({
        id: row.id,
        question: row.question,
        mode: row.mode,
        source: row.source,
        options:
          row.mode === 'vocabulary_definition'
            ? createMcqOptions(row.answer, vocabularyExerciseAnswerRows, row.question)
            : createMcqOptions(row.answer, questionExerciseAnswerRows, row.question),
        answer: row.answer,
      })),
      matching: matchingRows,
      fillBlank: fillRows,
      writing: writingRows.map((row) => ({
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
    },
  }
}

app.get('/api/health', (_, res) => {
  res.json({ ok: true })
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

    if (!word || !definition) {
      return res.status(400).json({ message: 'Cần có đầy đủ từ và định nghĩa' })
    }

    const { error } = await supabase.from('vocabulary').insert([{ word, definition, example }])
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

    if (!id || !word || !definition) {
      return res.status(400).json({ message: 'Dữ liệu gửi lên không hợp lệ' })
    }

    const { error } = await supabase
      .from('vocabulary')
      .update({ word, definition, example })
      .eq('id', id)
    assertNoSupabaseError(error, 'Không thể cập nhật từ vựng')
    clearDatabaseResponseCache()

    return res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/vocabulary/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ' })

    const { error } = await supabase.from('vocabulary').delete().eq('id', id)
    assertNoSupabaseError(error, 'Không thể xóa từ vựng')
    clearDatabaseResponseCache()

    return res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/vocabulary/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ' })

    const { error } = await supabase.from('vocabulary').delete().eq('id', id)
    assertNoSupabaseError(error, 'Không thể xóa từ vựng')
    clearDatabaseResponseCache()

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
      const { error } = await supabase.from('mcq_questions').delete().eq('id', id)
      assertNoSupabaseError(error, 'Không thể xóa câu hỏi trắc nghiệm')
      clearDatabaseResponseCache()
    }

    if (type === 'matching') {
      const { error } = await supabase.from('matching_questions').delete().eq('id', id)
      assertNoSupabaseError(error, 'Không thể xóa câu hỏi nối từ')
      clearDatabaseResponseCache()
    }

    if (type === 'fillBlank') {
      const { error } = await supabase.from('fill_blank_questions').delete().eq('id', id)
      assertNoSupabaseError(error, 'Không thể xóa câu hỏi điền chỗ trống')
      clearDatabaseResponseCache()
    }

    if (type === 'writing') {
      const { error } = await supabase.from('writing_questions').delete().eq('id', id)
      assertNoSupabaseError(error, 'Không thể xóa câu hỏi viết')
      clearDatabaseResponseCache()
    }

    if (type === 'listing') {
      const { error } = await supabase.from('writing_questions').delete().eq('id', id)
      assertNoSupabaseError(error, 'Không thể xóa câu hỏi liệt kê')
      clearDatabaseResponseCache()
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
      const { error } = await supabase.from('mcq_questions').delete().eq('id', id)
      assertNoSupabaseError(error, 'Không thể xóa câu hỏi trắc nghiệm')
      clearDatabaseResponseCache()
    }

    if (type === 'matching') {
      const { error } = await supabase.from('matching_questions').delete().eq('id', id)
      assertNoSupabaseError(error, 'Không thể xóa câu hỏi nối từ')
      clearDatabaseResponseCache()
    }

    if (type === 'fillBlank') {
      const { error } = await supabase.from('fill_blank_questions').delete().eq('id', id)
      assertNoSupabaseError(error, 'Không thể xóa câu hỏi điền chỗ trống')
      clearDatabaseResponseCache()
    }

    if (type === 'writing') {
      const { error } = await supabase.from('writing_questions').delete().eq('id', id)
      assertNoSupabaseError(error, 'Không thể xóa câu hỏi viết')
      clearDatabaseResponseCache()
    }

    if (type === 'listing') {
      const { error } = await supabase.from('writing_questions').delete().eq('id', id)
      assertNoSupabaseError(error, 'Không thể xóa câu hỏi liệt kê')
      clearDatabaseResponseCache()
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
  return res.status(500).json({ message: 'Lỗi máy chủ nội bộ' })
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
