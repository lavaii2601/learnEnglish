import cors from 'cors'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const dataDir = path.join(rootDir, 'data')
const dbFile = path.join(dataDir, 'english_lab.db')
const fillDbFile = path.join(dataDir, 'english_lab_fill_blank.db')

const app = express()
const PORT = Number(process.env.PORT || 3001)

app.use(cors())
app.use(express.json())

let db

function toQuestionType(type) {
  if (type === 'mcq') return 'mcq'
  if (type === 'matching') return 'matching'
  if (type === 'fillBlank') return 'fillBlank'
  if (type === 'writing') return 'writing'
  return null
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
    q.includes('định nghĩa') ||
    q.includes('định nghia') ||
    q.includes('define') ||
    q.includes('viết') ||
    q.includes('write')
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

function questionHints(question) {
  const text = normalizeForCompare(question)
  return {
    wantsGrammar: text.includes('ngữ pháp') || text.includes('grammar'),
    wantsSynonym: text.includes('đồng nghĩa') || text.includes('synonym'),
  }
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

  const scoredCandidates = uniqueCandidates
    .map((row) => ({
      answer: row.answer,
      score: distractorScore(currentAnswer, currentQuestion, row.answer, row.question),
    }))
    .sort((left, right) => right.score - left.score)

  const shortlist = scoredCandidates.slice(0, Math.min(8, scoredCandidates.length))
  const pickedDistractors = shuffleList(shortlist)
    .slice(0, 3)
    .map((item) => item.answer)

  // Keep four options even when data is still sparse.
  while (pickedDistractors.length < 3) {
    pickedDistractors.push(`Phương án nhiễu ${pickedDistractors.length + 1}`)
  }

  return shuffleList([currentAnswer, ...pickedDistractors])
}

async function initDatabase() {
  await fs.mkdir(dataDir, { recursive: true })
  db = await open({
    filename: dbFile,
    driver: sqlite3.Database,
  })

  await db.exec(`
    CREATE TABLE IF NOT EXISTS vocabulary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL,
      definition TEXT NOT NULL,
      example TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mcq_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      option_c TEXT NOT NULL,
      option_d TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'general',
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS matching_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL,
      meaning TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS fill_blank_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sentence TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS writing_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL,
      hint TEXT NOT NULL,
      keywords TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  await ensureMcqModeColumn()
  await migrateLegacyFillBlankDatabase()

  await seedIfEmpty()
}

async function migrateLegacyFillBlankDatabase() {
  try {
    await fs.access(fillDbFile)
  } catch {
    return
  }

  const legacyDb = await open({
    filename: fillDbFile,
    driver: sqlite3.Database,
  })

  try {
    const rows = await legacyDb.all(
      'SELECT sentence, answer FROM fill_blank_questions ORDER BY id ASC',
    )

    for (const row of rows) {
      const sentence = String(row.sentence || '').trim()
      const answer = String(row.answer || '').trim()
      if (!sentence || !answer) continue

      const exists = await db.get(
        `SELECT id FROM fill_blank_questions
         WHERE LOWER(TRIM(sentence)) = LOWER(TRIM(?))
           AND LOWER(TRIM(answer)) = LOWER(TRIM(?))
         LIMIT 1`,
        sentence,
        answer,
      )

      if (!exists) {
        await db.run(
          'INSERT INTO fill_blank_questions (sentence, answer) VALUES (?, ?)',
          sentence,
          answer,
        )
      }
    }
  } finally {
    await legacyDb.close()
  }
}

async function ensureMcqModeColumn() {
  const columns = await db.all('PRAGMA table_info(mcq_questions)')
  const hasMode = columns.some((column) => column.name === 'mode')
  if (!hasMode) {
    await db.exec("ALTER TABLE mcq_questions ADD COLUMN mode TEXT NOT NULL DEFAULT 'general'")
  }
}

async function seedIfEmpty() {
  const vocabCount = await db.get('SELECT COUNT(*) AS total FROM vocabulary')
  const fillCount = await db.get('SELECT COUNT(*) AS total FROM fill_blank_questions')

  if (vocabCount.total === 0) {
    await db.run(
      'INSERT INTO vocabulary (word, definition, example) VALUES (?, ?, ?)',
      'resilient',
      'Có khả năng phục hồi nhanh sau tình huống khó khăn.',
      'Một học sinh kiên cường vẫn tiếp tục học sau khi mắc lỗi.',
    )
    await db.run(
      'INSERT INTO vocabulary (word, definition, example) VALUES (?, ?, ?)',
      'innovative',
      'Sử dụng ý tưởng mới và sáng tạo.',
      'Nhóm đã xây dựng một ứng dụng học tập đầy đổi mới.',
    )

    await db.run(
      `INSERT INTO mcq_questions (question, option_a, option_b, option_c, option_d, answer)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'Chọn từ đồng nghĩa đúng với "rapid".',
      'slow',
      'quick',
      'tiny',
      'silent',
      'quick',
    )

    await db.run(
      `INSERT INTO mcq_questions (question, option_a, option_b, option_c, option_d, answer)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'Câu nào dưới đây đúng ngữ pháp?',
      'She go to school every day.',
      'She goes to school every day.',
      'She going to school every day.',
      'She gone to school every day.',
      'She goes to school every day.',
    )

    await db.run(
      'INSERT INTO matching_questions (word, meaning) VALUES (?, ?)',
      'diligent',
      'hard-working and careful',
    )
    await db.run(
      'INSERT INTO matching_questions (word, meaning) VALUES (?, ?)',
      'ancient',
      'very old; from long ago',
    )
    await db.run(
      'INSERT INTO matching_questions (word, meaning) VALUES (?, ?)',
      'thrive',
      'to grow strongly and successfully',
    )

    await db.run(
      'INSERT INTO writing_questions (word, hint, keywords) VALUES (?, ?, ?)',
      'resilient',
      'Viết định nghĩa bằng tiếng Anh và thêm một ví dụ.',
      JSON.stringify(['recover', 'difficult', 'strong']),
    )
    await db.run(
      'INSERT INTO writing_questions (word, hint, keywords) VALUES (?, ?, ?)',
      'innovative',
      'Định nghĩa từ và nhắc đến ý tưởng hoặc phương pháp mới.',
      JSON.stringify(['new', 'idea', 'method']),
    )
  }

  if (fillCount.total === 0) {
    await db.run(
      'INSERT INTO fill_blank_questions (sentence, answer) VALUES (?, ?)',
      'I usually ___ coffee in the morning.',
      'drink',
    )
    await db.run(
      'INSERT INTO fill_blank_questions (sentence, answer) VALUES (?, ?)',
      'If it rains, we ___ at home.',
      'will stay',
    )
  }
}

async function buildDatabasePayload(mcqSourceModeInput = 'mix') {
  const mcqSourceMode = toMcqExerciseSourceMode(mcqSourceModeInput)

  const vocabularyRows = await db.all(
    'SELECT id, word, definition, example FROM vocabulary ORDER BY id DESC',
  )

  const mcqRows = await db.all(
    `SELECT id, question, option_a, option_b, option_c, option_d, mode, answer
     FROM mcq_questions ORDER BY id DESC`,
  )

  const matchingRows = await db.all(
    'SELECT id, word, meaning FROM matching_questions ORDER BY id DESC',
  )

  const fillRows = await db.all(
    'SELECT id, sentence, answer FROM fill_blank_questions ORDER BY id DESC',
  )

  const vocabularyDefinitions = vocabularyRows
    .map((row) => String(row.definition || '').trim())
    .filter(Boolean)

  const writingRows = await db.all(
    'SELECT id, word, hint, keywords FROM writing_questions ORDER BY id DESC',
  )

  const allMcqAnswerRows = mcqRows
    .map((row) => ({
      answer: String(row.answer || '').trim(),
      question: String(row.question || '').trim(),
    }))
    .filter((row) => row.answer)

  const vocabularyMcqRows = vocabularyRows.map((row) => ({
    id: `vocab-${row.id}`,
    question: `Nghĩa của từ "${row.word}" là gì?`,
    answer: String(row.definition || '').trim(),
    mode: 'vocabulary_definition',
    source: 'vocabulary',
  }))

  const questionMcqRows = mcqRows.map((row) => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    mode: toMcqMode(row.mode),
    source: 'question',
  }))

  let mcqExerciseRows = []
  if (mcqSourceMode === 'vocabulary') {
    mcqExerciseRows = vocabularyMcqRows
  }
  if (mcqSourceMode === 'question') {
    mcqExerciseRows = questionMcqRows
  }
  if (mcqSourceMode === 'mix') {
    mcqExerciseRows = [...questionMcqRows, ...vocabularyMcqRows]
  }

  mcqExerciseRows = shuffleList(mcqExerciseRows)

  const combinedAnswerRows = mcqExerciseRows
    .map((row) => ({
      answer: String(row.answer || '').trim(),
      question: String(row.question || '').trim(),
    }))
    .filter((row) => row.answer)

  return {
    vocabulary: vocabularyRows,
    questions: {
      mcq: mcqRows.map((row) => ({
        id: row.id,
        question: row.question,
        mode: toMcqMode(row.mode),
        options:
          toMcqMode(row.mode) === 'vocabulary_definition'
            ? createMcqOptions(row.answer, vocabularyDefinitions.map((answer) => ({ answer, question: '' })), row.question)
            : createMcqOptions(row.answer, allMcqAnswerRows, row.question),
        answer: row.answer,
      })),
      mcqExercise: mcqExerciseRows.map((row) => ({
        id: row.id,
        question: row.question,
        mode: row.mode,
        source: row.source,
        options:
          row.mode === 'vocabulary_definition'
            ? createMcqOptions(
              row.answer,
              vocabularyDefinitions.map((answer) => ({ answer, question: '' })),
              row.question,
            )
            : createMcqOptions(row.answer, combinedAnswerRows, row.question),
        answer: row.answer,
      })),
      matching: matchingRows,
      fillBlank: fillRows,
      writing: writingRows.map((row) => ({
        id: row.id,
        word: row.word,
        hint: row.hint,
        keywords: JSON.parse(row.keywords),
      })),
    },
  }
}

app.get('/api/health', (_, res) => {
  res.json({ ok: true })
})

app.get('/api/database', async (req, res, next) => {
  try {
    const payload = await buildDatabasePayload(req.query.mcqMode)
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

    await db.run(
      'INSERT INTO vocabulary (word, definition, example) VALUES (?, ?, ?)',
      word,
      definition,
      example,
    )

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

    await db.run(
      'UPDATE vocabulary SET word = ?, definition = ?, example = ? WHERE id = ?',
      word,
      definition,
      example,
      id,
    )

    return res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/vocabulary/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ' })

    await db.run('DELETE FROM vocabulary WHERE id = ?', id)
    return res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/questions', async (req, res, next) => {
  try {
    const questionText = String(req.body.question || '').trim()
    const answerText = String(req.body.answer || '').trim()
    const explicitType = toQuestionType(req.body.type)
    const type = explicitType || detectQuestionType(questionText, answerText)
    if (!type) return res.status(400).json({ message: 'Loại câu hỏi không hợp lệ' })

    if (type === 'mcq') {
      let mode = toMcqMode(req.body.mode)
      const question = questionText
      const answer = answerText
      if (!question || !answer) {
        return res.status(400).json({ message: 'Dữ liệu câu hỏi trắc nghiệm không hợp lệ' })
      }

      if (!req.body.mode) {
        const vocabularyHit = await db.get(
          'SELECT id FROM vocabulary WHERE LOWER(TRIM(definition)) = LOWER(TRIM(?))',
          answer,
        )
        if (vocabularyHit) {
          mode = 'vocabulary_definition'
        }
      }

      if (mode === 'vocabulary_definition') {
        const vocabHit = await db.get(
          'SELECT id FROM vocabulary WHERE LOWER(TRIM(definition)) = LOWER(TRIM(?))',
          answer,
        )
        if (!vocabHit) {
          return res.status(400).json({
            message: 'Với loại từ vựng-định nghĩa, đáp án đúng phải là một định nghĩa đã có trong kho từ vựng.',
          })
        }
      }

      await db.run(
        `INSERT INTO mcq_questions (question, option_a, option_b, option_c, option_d, mode, answer)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        question,
        '',
        '',
        '',
        '',
        mode,
        answer,
      )
    }

    if (type === 'matching') {
      const word = String(req.body.word || '').trim() || extractWordFromQuestion(questionText)
      const meaning = String(req.body.meaning || '').trim() || answerText
      if (!word || !meaning) {
        return res.status(400).json({ message: 'Dữ liệu bài nối từ không hợp lệ' })
      }
      await db.run(
        'INSERT INTO matching_questions (word, meaning) VALUES (?, ?)',
        word,
        meaning,
      )
    }

    if (type === 'fillBlank') {
      const sentence = String(req.body.sentence || '').trim() || questionText
      const answer = answerText
      if (!sentence || !answer) {
        return res.status(400).json({ message: 'Dữ liệu bài điền chỗ trống không hợp lệ' })
      }
      await db.run(
        'INSERT INTO fill_blank_questions (sentence, answer) VALUES (?, ?)',
        sentence,
        answer,
      )
    }

    if (type === 'writing') {
      const word = String(req.body.word || '').trim() || extractWordFromQuestion(questionText) || 'Từ mới'
      const hint = String(req.body.hint || '').trim() || questionText
      const keywords = Array.isArray(req.body.keywords) && req.body.keywords.length
        ? req.body.keywords
        : toKeywords(answerText)
      if (!word || !hint) {
        return res.status(400).json({ message: 'Dữ liệu bài viết không hợp lệ' })
      }
      await db.run(
        'INSERT INTO writing_questions (word, hint, keywords) VALUES (?, ?, ?)',
        word,
        hint,
        JSON.stringify(keywords),
      )
    }

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
        const vocabHit = await db.get(
          'SELECT id FROM vocabulary WHERE LOWER(TRIM(definition)) = LOWER(TRIM(?))',
          answer,
        )
        if (!vocabHit) {
          return res.status(400).json({
            message: 'Với loại từ vựng-định nghĩa, đáp án đúng phải là một định nghĩa đã có trong kho từ vựng.',
          })
        }
      }

      await db.run(
        `UPDATE mcq_questions
         SET question = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, mode = ?, answer = ?
         WHERE id = ?`,
        question,
        '',
        '',
        '',
        '',
        mode,
        answer,
        id,
      )
    }

    if (type === 'matching') {
      const word = String(req.body.word || '').trim()
      const meaning = String(req.body.meaning || '').trim()
      if (!word || !meaning) {
        return res.status(400).json({ message: 'Dữ liệu bài nối từ không hợp lệ' })
      }
      await db.run(
        'UPDATE matching_questions SET word = ?, meaning = ? WHERE id = ?',
        word,
        meaning,
        id,
      )
    }

    if (type === 'fillBlank') {
      const sentence = String(req.body.sentence || '').trim()
      const answer = String(req.body.answer || '').trim()
      if (!sentence || !answer) {
        return res.status(400).json({ message: 'Dữ liệu bài điền chỗ trống không hợp lệ' })
      }
      await db.run(
        'UPDATE fill_blank_questions SET sentence = ?, answer = ? WHERE id = ?',
        sentence,
        answer,
        id,
      )
    }

    if (type === 'writing') {
      const word = String(req.body.word || '').trim()
      const hint = String(req.body.hint || '').trim()
      const keywords = Array.isArray(req.body.keywords) ? req.body.keywords : []
      if (!word || !hint) {
        return res.status(400).json({ message: 'Dữ liệu bài viết không hợp lệ' })
      }
      await db.run(
        'UPDATE writing_questions SET word = ?, hint = ?, keywords = ? WHERE id = ?',
        word,
        hint,
        JSON.stringify(keywords),
        id,
      )
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
      await db.run('DELETE FROM mcq_questions WHERE id = ?', id)
    }

    if (type === 'matching') {
      await db.run('DELETE FROM matching_questions WHERE id = ?', id)
    }

    if (type === 'fillBlank') {
      await db.run('DELETE FROM fill_blank_questions WHERE id = ?', id)
    }

    if (type === 'writing') {
      await db.run('DELETE FROM writing_questions WHERE id = ?', id)
    }

    return res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.use((error, _, res, __) => {
  console.error(error)
  res.status(500).json({ message: 'Lỗi máy chủ nội bộ' })
})

async function start() {
  await initDatabase()
  app.listen(PORT, () => {
    console.log(`Máy chủ API đang chạy tại http://localhost:${PORT}`)
  })
}

start().catch((error) => {
  console.error('Không thể khởi động máy chủ API:', error)
  process.exit(1)
})
