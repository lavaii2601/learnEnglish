const STORAGE_KEY = 'english_lab_database_v1'

const defaultDatabase = {
  vocabulary: [
    {
      id: crypto.randomUUID(),
      word: 'resilient',
      definition: 'Có khả năng phục hồi nhanh sau tình huống khó khăn.',
      example: 'Một học sinh kiên cường vẫn tiếp tục học sau khi mắc lỗi.',
    },
    {
      id: crypto.randomUUID(),
      word: 'innovative',
      definition: 'Sử dụng ý tưởng mới và sáng tạo.',
      example: 'Nhóm đã xây dựng một ứng dụng học tập đầy đổi mới.',
    },
  ],
  questions: {
    mcq: [
      {
        id: crypto.randomUUID(),
        question: 'Chọn từ đồng nghĩa đúng với "rapid".',
        options: ['slow', 'quick', 'tiny', 'silent'],
        answer: 'quick',
      },
      {
        id: crypto.randomUUID(),
        question: 'Câu nào dưới đây đúng ngữ pháp?',
        options: [
          'She go to school every day.',
          'She goes to school every day.',
          'She going to school every day.',
          'She gone to school every day.',
        ],
        answer: 'She goes to school every day.',
      },
    ],
    matching: [
      {
        id: crypto.randomUUID(),
        word: 'diligent',
        meaning: 'hard-working and careful',
      },
      {
        id: crypto.randomUUID(),
        word: 'ancient',
        meaning: 'very old; from long ago',
      },
      {
        id: crypto.randomUUID(),
        word: 'thrive',
        meaning: 'to grow strongly and successfully',
      },
    ],
    fillBlank: [
      {
        id: crypto.randomUUID(),
        sentence: 'I usually ___ coffee in the morning.',
        answer: 'drink',
      },
      {
        id: crypto.randomUUID(),
        sentence: 'If it rains, we ___ at home.',
        answer: 'will stay',
      },
    ],
    writing: [
      {
        id: crypto.randomUUID(),
        word: 'resilient',
        hint: 'Viết định nghĩa bằng tiếng Anh và thêm một ví dụ.',
        keywords: ['recover', 'difficult', 'strong'],
      },
      {
        id: crypto.randomUUID(),
        word: 'innovative',
        hint: 'Định nghĩa từ và nhắc đến ý tưởng hoặc phương pháp mới.',
        keywords: ['new', 'idea', 'method'],
      },
    ],
  },
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data))
}

function ensureDatabaseShape(data) {
  if (!data || typeof data !== 'object') return cloneData(defaultDatabase)
  const safe = cloneData(defaultDatabase)

  safe.vocabulary = Array.isArray(data.vocabulary) ? data.vocabulary : safe.vocabulary
  const questions = data.questions || {}

  safe.questions.mcq = Array.isArray(questions.mcq) ? questions.mcq : safe.questions.mcq
  safe.questions.matching = Array.isArray(questions.matching)
    ? questions.matching
    : safe.questions.matching
  safe.questions.fillBlank = Array.isArray(questions.fillBlank)
    ? questions.fillBlank
    : safe.questions.fillBlank
  safe.questions.writing = Array.isArray(questions.writing)
    ? questions.writing
    : safe.questions.writing

  return safe
}

export function loadDatabase() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = cloneData(defaultDatabase)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }

  try {
    return ensureDatabaseShape(JSON.parse(raw))
  } catch {
    const seeded = cloneData(defaultDatabase)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

export function saveDatabase(database) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(database))
}

export function addVocabularyItem(database, payload) {
  database.vocabulary.unshift({
    id: crypto.randomUUID(),
    word: payload.word,
    definition: payload.definition,
    example: payload.example,
  })
  saveDatabase(database)
}

export function addQuestionItem(database, payload) {
  const { type } = payload

  if (type === 'mcq') {
    database.questions.mcq.unshift({
      id: crypto.randomUUID(),
      question: payload.question,
      options: payload.options,
      answer: payload.answer,
    })
  }

  if (type === 'matching') {
    database.questions.matching.unshift({
      id: crypto.randomUUID(),
      word: payload.word,
      meaning: payload.meaning,
    })
  }

  if (type === 'fillBlank') {
    database.questions.fillBlank.unshift({
      id: crypto.randomUUID(),
      sentence: payload.sentence,
      answer: payload.answer,
    })
  }

  if (type === 'writing') {
    database.questions.writing.unshift({
      id: crypto.randomUUID(),
      word: payload.word,
      hint: payload.hint,
      keywords: payload.keywords,
    })
  }

  saveDatabase(database)
}
