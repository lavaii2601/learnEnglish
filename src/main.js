import './style.css'
import {
  createQuestion,
  createVocabulary,
  deleteQuestion,
  deleteVocabulary,
  fetchDatabase,
  updateQuestion,
  updateVocabulary,
} from './api'

const app = document.querySelector('#app')
const SIDEBAR_OPEN_STORAGE_KEY = 'english_lab_sidebar_open'
const DATABASE_CACHE_TTL_MS = 30_000
const LISTING_MATCH_THRESHOLD = 0.7

function loadSidebarOpenState() {
  const stored = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY)
  if (stored === 'true') return true
  if (stored === 'false') return false
  return true
}

const state = {
  route: getRoute(),
  database: {
    vocabulary: [],
    questions: { mcq: [], matching: [], fillBlank: [], writing: [], listing: [] },
  },
  mcqAnswers: [],
  matchingQuestionCount: 5,
  matchingSessionIds: [],
  matchingRightColumnIds: [],
  matchingPairs: {},
  matchingSelectedLeftId: null,
  matchingChecked: false,
  blankAnswers: [],
  writingAnswers: [],
  listingAnswers: [],
  listingQuestionCount: 5,
  listingSessionIndexes: [],
  listingCurrentIndex: 0,
  listingCheckedMap: [],
  slideBoardOpen: false,
  sidebarOpen: loadSidebarOpenState(),
  sourceGroupOpen: false,
  resultNotice: null,
  serverError: '',
  loading: true,
  sourceMessage: '',
  sourceMessageType: 'ok',
  mcqSourceMode: 'mix',
  mcqQuestionCount: 5,
  mcqSessionPhase: 'setup',
  mcqPoolQuestions: [],
  mcqQuizQuestions: [],
  mcqExcludeCorrectEnabled: true,
  mcqCorrectQuestionIds: [],
  mcqCurrentIndex: 0,
  mcqNextPromptOpen: false,
  mcqReviewOpen: false,
  mcqWrongQuestions: [],
  databaseCache: {},
  listingPreparedDirty: true,
  listingPreparedCacheItems: [],
  writingScoreDirty: true,
  writingScoreCache: [],
  listingScoreDirty: true,
  listingScoreCache: [],
}

let renderScheduled = false
let exerciseEventsBound = false

function isSourceRoute(route) {
  return route.startsWith('/source/')
}

function cloneDatabasePayload(payload) {
  return JSON.parse(JSON.stringify(payload))
}

function getDatabaseCacheKey() {
  if (state.route === '/exercise/mcq') {
    return `mcq:${state.mcqSourceMode}`
  }
  return 'default'
}

function getCachedDatabaseEntry() {
  const key = getDatabaseCacheKey()
  const cached = state.databaseCache[key]
  if (!cached) return null
  if (Date.now() - cached.timestamp > DATABASE_CACHE_TTL_MS) return null
  return cached
}

function saveDatabaseCache(payload) {
  const key = getDatabaseCacheKey()
  state.databaseCache[key] = {
    timestamp: Date.now(),
    data: cloneDatabasePayload(payload),
  }
}

function clearDatabaseCache() {
  state.databaseCache = {}
}

function normalizeText(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function cleanListLine(text) {
  return String(text || '')
    .replace(/^\s*(?:[-*•]|\d+[.)-])\s*/, '')
    .replace(/[;,.!?]+$/g, '')
    .trim()
}

function normalizeListLine(text) {
  return normalizeText(cleanListLine(text))
}

function parseAnswerLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => normalizeListLine(line))
    .filter(Boolean)
}

function parseWritingSampleLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => cleanListLine(line))
    .filter(Boolean)
}

function tokenizeWords(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((word) => word.trim())
    .filter(Boolean)
}

function getListingPreparedItems() {
  const list = state.database.questions.listing || []
  if (!state.listingPreparedDirty) {
    return state.listingPreparedCacheItems
  }

  const preparedItems = list.map((item) => {
    const expectedEntries = (Array.isArray(item.answers) ? item.answers : [])
      .map((line) => cleanListLine(line))
      .filter(Boolean)
      .map((line) => ({
        raw: line,
        normalized: normalizeListLine(line),
        words: tokenizeWords(normalizeListLine(line)),
      }))

    return {
      ...item,
      expectedEntries,
    }
  })

  state.listingPreparedCacheItems = preparedItems
  state.listingPreparedDirty = false
  return preparedItems
}

function getWordMatchDetail(expectedWords, userWords) {
  const expectedUnique = [...new Set(expectedWords)]
  const userWordSet = new Set(userWords)
  const words = expectedUnique.map((word) => ({
    word,
    matched: userWordSet.has(word),
  }))
  const matchedCount = words.filter((item) => item.matched).length
  const ratio = expectedUnique.length ? matchedCount / expectedUnique.length : 0

  return {
    words,
    matchedCount,
    totalWords: expectedUnique.length,
    ratio,
  }
}

function linesMatch(userLine, expectedLine) {
  if (!userLine || !expectedLine) return false
  if (userLine === expectedLine) return true
  return userLine.includes(expectedLine) || expectedLine.includes(userLine)
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function getRoute() {
  const hash = window.location.hash || '#/home'
  const route = hash.replace('#', '')
  if (route === '/source') return '/source/vocab'
  return route
}

function setRoute(route) {
  window.location.hash = `#${route}`
}

function buildFallbackOptions(correctAnswer, question, pool) {
  const uniquePool = [...new Set(pool.filter((item) => item && item !== correctAnswer))]
  const correctFamily = getMcqFamily(question, correctAnswer)
  const sameFamilyPool = uniquePool.filter((item) => getMcqFamily(question, item) === correctFamily)
  const correctProfile = getAnswerProfile(correctAnswer)
  const sameShapePool = uniquePool.filter((item) => answersShareShape(correctProfile, getAnswerProfile(item)))
  const candidatePool = [...sameFamilyPool, ...sameShapePool, ...uniquePool]
    .filter((item, index, items) => index === items.findIndex((candidate) => candidate === item))
  const distractors = getShuffledItems(candidatePool).slice(0, 3)
  return getShuffledItems([correctAnswer, ...distractors])
}

function getAnswerProfile(answer) {
  const value = normalizeText(answer)
  const words = value.split(/\s+/).filter(Boolean)

  return {
    isSingleWord: words.length === 1,
    isSentenceLike: /[.!?]$/.test(value) || words.length >= 5,
  }
}

function answersShareShape(targetProfile, candidateProfile) {
  return targetProfile.isSingleWord === candidateProfile.isSingleWord
    && targetProfile.isSentenceLike === candidateProfile.isSentenceLike
}

function getMcqFamily(question, answer) {
  const normalizedQuestion = normalizeText(question)
  const answerProfile = getAnswerProfile(answer)

  if (normalizedQuestion.includes('nghĩa của từ') || normalizedQuestion.includes('nghia cua tu') || normalizedQuestion.includes('meaning of the word')) {
    return 'vocabulary_definition'
  }
  if (normalizedQuestion.includes('ngữ pháp') || normalizedQuestion.includes('grammar')) {
    return 'grammar_sentence'
  }
  if (normalizedQuestion.includes('đồng nghĩa') || normalizedQuestion.includes('synonym')) {
    return 'synonym_word'
  }
  if (answerProfile.isSentenceLike) return 'sentence_like'
  if (answerProfile.isSingleWord) return 'single_word'
  return 'general'
}

function getClientFallbackMcqItems() {
  const vocabularyItems = state.database.vocabulary
    .filter((item) => String(item.definition || '').trim())
    .map((item) => ({
      id: `fallback-vocab-${item.id}`,
      question: `Nghĩa của từ "${item.word}" là gì?`,
      answer: String(item.definition || '').trim(),
      source: 'vocabulary',
      mode: 'vocabulary_definition',
    }))

  const questionItems = (state.database.questions.mcq || [])
    .filter((item) => String(item.answer || '').trim())
    .map((item) => ({
      id: `fallback-question-${item.id}`,
      question: item.question,
      answer: item.answer,
      source: 'question',
      mode: item.mode || 'general',
    }))

  let selectedItems = []
  if (state.mcqSourceMode === 'vocabulary') {
    selectedItems = vocabularyItems
  }
  if (state.mcqSourceMode === 'question') {
    selectedItems = questionItems
  }
  if (state.mcqSourceMode === 'mix') {
    selectedItems = [
      ...questionItems,
      ...vocabularyItems,
    ]
  }

  const vocabularyAnswerPool = vocabularyItems.map((item) => item.answer)
  const questionAnswerPool = questionItems.map((item) => item.answer)

  const getPoolForItem = (item) => (item.source === 'vocabulary' ? vocabularyAnswerPool : questionAnswerPool)

  return getShuffledItems(selectedItems).map((item) => ({
    id: item.id,
    question: item.question,
    answer: item.answer,
    mode: item.mode,
    source: item.source,
    options: buildFallbackOptions(item.answer, item.question, getPoolForItem(item)),
  }))
}

function getMcqExerciseItems() {
  if (Array.isArray(state.database.questions.mcqExercise)) {
    return state.database.questions.mcqExercise
  }
  return getClientFallbackMcqItems()
}

function normalizeMcqQuestionId(value) {
  return String(value || '').trim()
}

function getFilteredMcqPool(items) {
  if (!state.mcqExcludeCorrectEnabled) return [...items]
  const blockedIdSet = new Set(state.mcqCorrectQuestionIds.map((id) => normalizeMcqQuestionId(id)))
  return items.filter((item) => !blockedIdSet.has(normalizeMcqQuestionId(item.id)))
}

function prepareMcqPool() {
  const rawPool = getMcqExerciseItems()
  state.mcqPoolQuestions = getFilteredMcqPool(rawPool)
}

function getShuffledItems(items) {
  const list = [...items]
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[list[index], list[swapIndex]] = [list[swapIndex], list[index]]
  }
  return list
}

function buildListingSessionIndexes(totalQuestions) {
  const cappedTotal = Math.max(0, Number(totalQuestions) || 0)
  if (!cappedTotal) return []

  const maxAllowed = Math.min(5, cappedTotal)
  const selectedCount = Math.min(maxAllowed, Math.max(1, state.listingQuestionCount || 1))
  const allIndexes = Array.from({ length: cappedTotal }, (_, index) => index)
  return getShuffledItems(allIndexes).slice(0, selectedCount)
}

function resetListingSession(totalQuestions) {
  state.listingSessionIndexes = buildListingSessionIndexes(totalQuestions)
  state.listingCurrentIndex = state.listingSessionIndexes[0] || 0
  state.listingCheckedMap = Array(totalQuestions).fill(false)
}

function resetMatchingSession(totalQuestions = (state.database.questions.matching || []).length) {
  const cappedTotal = Math.max(0, Number(totalQuestions) || 0)
  if (!cappedTotal) {
    state.matchingSessionIds = []
    state.matchingRightColumnIds = []
    state.matchingPairs = {}
    state.matchingSelectedLeftId = null
    state.matchingChecked = false
    return
  }

  const maxAllowed = Math.min(10, cappedTotal)
  const selectedCount = Math.min(maxAllowed, Math.max(1, state.matchingQuestionCount || 1))
  const allIds = getShuffledItems(Array.from({ length: cappedTotal }, (_, index) => state.database.questions.matching[index].id))
  const selectedIds = allIds.slice(0, selectedCount)

  state.matchingSessionIds = selectedIds
  state.matchingRightColumnIds = getShuffledItems(selectedIds)
  state.matchingPairs = {}
  state.matchingSelectedLeftId = selectedIds[0] || null
  state.matchingChecked = false
}

function invalidateScoreCaches() {
  state.writingScoreDirty = true
  state.listingScoreDirty = true
}

function pickMixedQuizItems(pool, maxCount) {
  if (!Array.isArray(pool) || maxCount <= 0) return []

  const vocabularyItems = pool.filter((item) => item?.source === 'vocabulary')
  const questionItems = pool.filter((item) => item?.source === 'question')

  const shuffledVocabulary = getShuffledItems(vocabularyItems)
  const shuffledQuestions = getShuffledItems(questionItems)
  const picked = []

  // Guarantee at least one question from each source when both sources exist.
  if (shuffledVocabulary.length && shuffledQuestions.length && maxCount >= 2) {
    picked.push(shuffledQuestions.pop())
    picked.push(shuffledVocabulary.pop())
  }

  const remainingPool = getShuffledItems([
    ...shuffledQuestions,
    ...shuffledVocabulary,
  ])

  while (picked.length < maxCount && remainingPool.length) {
    picked.push(remainingPool.pop())
  }

  return getShuffledItems(picked)
}

function getMcqItemKey(item) {
  const id = normalizeMcqQuestionId(item?.id)
  if (id) return `id:${id}`
  return `qa:${normalizeText(item?.question || '')}::${normalizeText(item?.answer || '')}`
}

function startMcqQuizRound(options = {}) {
  const {
    useWrongOnly = false,
    appendWrongQuestions = false,
    wrongQuestions = state.mcqWrongQuestions,
  } = options

  const wrongList = Array.isArray(wrongQuestions) ? wrongQuestions : []
  const basePool = useWrongOnly && wrongList.length
    ? wrongList
    : state.mcqPoolQuestions
  const pool = Array.isArray(basePool) ? basePool : []
  const maxCount = Math.min(state.mcqQuestionCount || 5, pool.length)
  const baseQuizItems = state.mcqSourceMode === 'mix'
    ? pickMixedQuizItems(pool, maxCount)
    : getShuffledItems(pool).slice(0, maxCount)
  const baseKeySet = new Set(baseQuizItems.map((entry) => getMcqItemKey(entry)))

  const quizItems = appendWrongQuestions && wrongList.length
    ? [
      ...baseQuizItems,
      ...wrongList.filter((item) => !baseKeySet.has(getMcqItemKey(item))),
    ]
    : baseQuizItems

  state.mcqQuizQuestions = quizItems
  state.mcqAnswers = Array(quizItems.length).fill('')
  state.mcqCurrentIndex = 0
  state.mcqNextPromptOpen = false
  state.mcqReviewOpen = false
  state.mcqSessionPhase = 'playing'
  state.mcqWrongQuestions = []
}

function resetExerciseState() {
  const {
    matching,
    fillBlank,
    writing,
    listing = [],
  } = state.database.questions
  prepareMcqPool()
  state.mcqQuizQuestions = []
  state.mcqAnswers = []
  state.mcqCurrentIndex = 0
  state.mcqNextPromptOpen = false
  state.mcqReviewOpen = false
  state.mcqSessionPhase = 'setup'
  state.mcqWrongQuestions = []
  resetMatchingSession(matching.length)
  state.blankAnswers = Array(fillBlank.length).fill('')
  state.writingAnswers = Array(writing.length).fill('')
  state.listingAnswers = Array(listing.length).fill('')
  resetListingSession(listing.length)
  state.listingPreparedDirty = true
  invalidateScoreCaches()
}

function getMatchingSessionItems() {
  const items = state.database.questions.matching || []
  const itemById = new Map(items.map((item) => [String(item.id), item]))

  const leftColumn = state.matchingSessionIds
    .map((id) => itemById.get(String(id)))
    .filter(Boolean)

  const rightColumn = state.matchingRightColumnIds
    .map((id) => itemById.get(String(id)))
    .filter(Boolean)

  return {
    leftColumn,
    rightColumn,
  }
}

function isMatchingRoundComplete() {
  if (!state.matchingSessionIds.length) return false
  return state.matchingSessionIds.every((id) => Number(state.matchingPairs[id]) > 0)
}

function scheduleRender() {
  if (renderScheduled) return
  renderScheduled = true
  window.requestAnimationFrame(() => {
    renderScheduled = false
    render()
  })
}

function scoreMcq() {
  let score = 0
  state.mcqQuizQuestions.forEach((item, index) => {
    if (state.mcqAnswers[index] === item.answer) score += 1
  })
  return score
}

function scoreMatching() {
  return state.matchingSessionIds.reduce((total, leftId) => {
    const selectedRightId = Number(state.matchingPairs[leftId])
    return total + (selectedRightId === Number(leftId) ? 1 : 0)
  }, 0)
}

function scoreBlanks() {
  let score = 0
  state.database.questions.fillBlank.forEach((item, index) => {
    if (normalizeText(state.blankAnswers[index] || '') === normalizeText(item.answer)) {
      score += 1
    }
  })
  return score
}

function scoreWriting() {
  if (!state.writingScoreDirty) return state.writingScoreCache

  const scores = state.database.questions.writing.map((item, index) => {
    const expectedLines = (Array.isArray(item.keywords) ? item.keywords : [])
      .map((line) => normalizeListLine(line))
      .filter(Boolean)
    const userLines = parseAnswerLines(state.writingAnswers[index] || '')

    const remainingUserLines = [...userLines]
    let hitCount = 0

    expectedLines.forEach((expectedLine) => {
      const exactIndex = remainingUserLines.findIndex((line) => line === expectedLine)
      if (exactIndex >= 0) {
        hitCount += 1
        remainingUserLines.splice(exactIndex, 1)
        return
      }

      const fuzzyIndex = remainingUserLines.findIndex((line) => linesMatch(line, expectedLine))
      if (fuzzyIndex >= 0) {
        hitCount += 1
        remainingUserLines.splice(fuzzyIndex, 1)
      }
    })

    const totalExpected = expectedLines.length
    const percent = totalExpected
      ? Math.round((hitCount / totalExpected) * 100)
      : 0

    return {
      hitCount,
      total: totalExpected,
      percent,
    }
  })
  state.writingScoreCache = scores
  state.writingScoreDirty = false
  return state.writingScoreCache
}

function getWritingCorrectCount(scores = scoreWriting()) {
  return scores.filter((item) => item.percent >= 60).length
}

function scoreListing() {
  if (!state.listingScoreDirty) return state.listingScoreCache

  const scores = getListingPreparedItems().map((item, index) => {
    const userLines = parseWritingSampleLines(state.listingAnswers[index] || '')

    const usedUserIndexes = new Set()
    const ideaDetails = item.expectedEntries.map((expectedEntry) => {
      const expectedNormalized = expectedEntry.normalized
      const expectedWords = expectedEntry.words

      let bestUserIndex = -1
      let bestRatio = 0
      let bestWordDetail = {
        words: [],
        matchedCount: 0,
        totalWords: expectedWords.length,
        ratio: 0,
      }

      userLines.forEach((userLine, userIndex) => {
        if (usedUserIndexes.has(userIndex)) return

        const userNormalized = normalizeListLine(userLine)
        const userWords = tokenizeWords(userNormalized)
        const wordDetail = getWordMatchDetail(expectedWords, userWords)

        let ratio = wordDetail.ratio
        if (userNormalized === expectedNormalized) {
          ratio = 1
        } else if (linesMatch(userNormalized, expectedNormalized)) {
          ratio = Math.max(ratio, LISTING_MATCH_THRESHOLD)
        }

        if (ratio > bestRatio) {
          bestRatio = ratio
          bestUserIndex = userIndex
          bestWordDetail = {
            ...wordDetail,
            ratio,
          }
        }
      })

      const isCorrect = bestRatio >= LISTING_MATCH_THRESHOLD
      if (isCorrect && bestUserIndex >= 0) {
        usedUserIndexes.add(bestUserIndex)
      }

      return {
        expected: expectedEntry.raw,
        user: bestUserIndex >= 0 ? userLines[bestUserIndex] : '',
        isCorrect,
        matchPercent: Math.round(bestRatio * 100),
        matchedCount: bestWordDetail.matchedCount,
        totalWords: bestWordDetail.totalWords,
        words: bestWordDetail.words,
      }
    })

    const hitCount = ideaDetails.filter((item) => item.isCorrect).length
    const totalExpected = item.expectedEntries.length
    const percent = totalExpected
      ? Math.round((hitCount / totalExpected) * 100)
      : 0

    return {
      hitCount,
      total: totalExpected,
      percent,
      ideaDetails,
    }
  })
  state.listingScoreCache = scores
  state.listingScoreDirty = false
  return state.listingScoreCache
}

function getListingCorrectCount(scores = scoreListing(), indexes = state.listingSessionIndexes) {
  const indexSet = new Set(indexes || [])
  return scores
    .filter((_, index) => indexSet.has(index))
    .filter((item) => item.percent >= LISTING_MATCH_THRESHOLD * 100)
    .length
}

function isMcqRoundComplete() {
  if (!state.mcqQuizQuestions.length) return false
  return state.mcqAnswers.every((answer) => String(answer || '').trim().length > 0)
}

function finishMcqSession() {
  const correctIds = state.mcqQuizQuestions
    .filter((item, index) => state.mcqAnswers[index] === item.answer)
    .map((item) => normalizeMcqQuestionId(item.id))

  if (correctIds.length) {
    const merged = new Set([
      ...state.mcqCorrectQuestionIds.map((id) => normalizeMcqQuestionId(id)),
      ...correctIds,
    ])
    state.mcqCorrectQuestionIds = [...merged]
  }

  state.mcqWrongQuestions = state.mcqQuizQuestions.filter((item, index) => state.mcqAnswers[index] !== item.answer)
  state.mcqSessionPhase = 'completed'
  state.mcqReviewOpen = true
  prepareMcqPool()
}

function openResultNotice(type) {
  if (type === 'mcq' && !isMcqRoundComplete()) {
    const totalMcqQuestions = state.mcqQuizQuestions.length || state.mcqQuestionCount || 5
    state.resultNotice = {
      type,
      title: 'Chưa hoàn thành bài trắc nghiệm',
      message: `Vui lòng trả lời đủ ${totalMcqQuestions} câu trước khi kiểm tra kết quả.`,
    }
    render()
    return
  }

  let correct = 0
  let total = 0
  let title = 'Kết quả bài tập'

  if (type === 'mcq') {
    correct = scoreMcq()
    total = state.mcqQuizQuestions.length
    title = 'Kết quả trắc nghiệm'
  }

  if (type === 'matching') {
    correct = scoreMatching()
    total = state.matchingSessionIds.length
    title = 'Kết quả nối từ'
  }

  if (type === 'fillBlank') {
    correct = scoreBlanks()
    total = state.database.questions.fillBlank.length
    title = 'Kết quả điền chỗ trống'
  }

  if (type === 'writing') {
    const writingScores = scoreWriting()
    correct = getWritingCorrectCount(writingScores)
    total = state.database.questions.writing.length
    title = 'Kết quả viết định nghĩa'
  }

  if (type === 'listing') {
    const listingScores = scoreListing()
    correct = getListingCorrectCount(listingScores, state.listingSessionIndexes)
    total = state.listingSessionIndexes.length
    title = 'Kết quả bài liệt kê'
  }

  state.resultNotice = {
    type,
    title,
    message: `Bạn làm đúng ${correct}/${total} câu.`,
  }

  render()
}

function renderLayout(content) {
  const routeTitleMap = {
    '/home': 'Trang chủ',
    '/exercise/mcq': 'Trắc nghiệm',
    '/exercise/matching': 'Nối từ',
    '/exercise/fill': 'Điền chỗ trống',
    '/exercise/writing': 'Viết định nghĩa',
    '/exercise/listing': 'Liệt kê ý',
    '/source/vocab': 'Thêm từ vựng',
    '/source/questions': 'Thêm câu hỏi',
    '/source/matching': 'Thêm từ nối',
  }

  const sourceGroupOpen = state.sourceGroupOpen || isSourceRoute(state.route)

  const questionAnswerCount = state.database.questions.mcq.length
  const vocabularyCount = state.database.vocabulary.length
  const mcqTotalCount = vocabularyCount + questionAnswerCount
  const totalQuestions =
    questionAnswerCount +
    state.database.questions.matching.length +
    state.database.questions.fillBlank.length +
    state.database.questions.writing.length +
    (state.database.questions.listing || []).length
  const listingCount = (state.database.questions.listing || []).length

  const quickBoardMarkup = `
    <header class="slide-board-head">
      <strong>Bảng nhanh</strong>
      <button type="button" class="slide-board-close" data-toggle-slide-board="true">Đóng</button>
    </header>
    <p class="muted">Theo dõi dữ liệu chính mà không cần rời menu.</p>
    <div class="slide-stat-grid">
      <article><span>Tổng câu hỏi</span><strong>${totalQuestions}</strong></article>
      <article><span>Từ vựng</span><strong>${vocabularyCount}</strong></article>
      <article><span>Câu hỏi/câu trả lời</span><strong>${questionAnswerCount}</strong></article>
      <article><span>Trắc nghiệm</span><strong>${mcqTotalCount}</strong></article>
      <article><span>Câu hỏi liệt kê</span><strong>${listingCount}</strong></article>
    </div>
  `

  return `
    <main class="shell app-shell ${state.sidebarOpen ? '' : 'menu-hidden'}">
      <aside class="sidebar">
        <img
          class="brand-logo sidebar-logo"
          src="/logo.jpg"
          alt="Logo Học tiếng Anh cùng Hồng Nga"
          onerror="this.style.display='none'"
        />
        <h1>Học tiếng Anh cùng Hồng Nga</h1>
        <p class="muted">Luyện tập và quản lý dữ liệu học tiếng Anh.</p>

        <p class="group-title">Điều hướng</p>
        <button class="nav-btn ${state.route === '/home' ? 'active' : ''}" data-route="/home">Trang chủ</button>

        <p class="group-title">Bài tập</p>
        <button class="nav-btn ${state.route === '/exercise/mcq' ? 'active' : ''}" data-route="/exercise/mcq">Trắc nghiệm</button>
        <button class="nav-btn ${state.route === '/exercise/matching' ? 'active' : ''}" data-route="/exercise/matching">Nối từ</button>
        <button class="nav-btn ${state.route === '/exercise/fill' ? 'active' : ''}" data-route="/exercise/fill">Điền chỗ trống</button>
        <button class="nav-btn ${state.route === '/exercise/writing' ? 'active' : ''}" data-route="/exercise/writing">Viết</button>
        <button class="nav-btn ${state.route === '/exercise/listing' ? 'active' : ''}" data-route="/exercise/listing">Liệt kê</button>

        <p class="group-title">Nguồn dữ liệu</p>
        <button
          class="nav-btn nav-group-toggle ${sourceGroupOpen ? 'active' : ''}"
          type="button"
          data-toggle-source-group="true"
          aria-expanded="${sourceGroupOpen ? 'true' : 'false'}"
        >
          <span>Thêm nguồn</span>
          <span class="nav-caret">${sourceGroupOpen ? '▾' : '▸'}</span>
        </button>
        <div class="nav-subgroup ${sourceGroupOpen ? 'open' : ''}">
          <button class="nav-btn nav-sub-btn ${state.route === '/source/vocab' ? 'active' : ''}" data-route="/source/vocab">Nhiệm vụ: Thêm từ vựng</button>
          <button class="nav-btn nav-sub-btn ${state.route === '/source/questions' ? 'active' : ''}" data-route="/source/questions">Nhiệm vụ: Thêm câu hỏi + trả lời</button>
          <button class="nav-btn nav-sub-btn ${state.route === '/source/matching' ? 'active' : ''}" data-route="/source/matching">Nhiệm vụ: Thêm từ nối</button>
        </div>

        <button
          class="slide-trigger ${state.slideBoardOpen ? 'active' : ''}"
          data-toggle-slide-board="true"
          type="button"
          aria-expanded="${state.slideBoardOpen ? 'true' : 'false'}"
        >
          ${state.slideBoardOpen ? 'Thu gọn bảng nhanh' : 'Mở bảng nhanh'}
        </button>

        <section class="slide-board ${state.slideBoardOpen ? 'open' : ''}" aria-hidden="${state.slideBoardOpen ? 'false' : 'true'}">
          ${quickBoardMarkup}
        </section>
      </aside>

      <button
        type="button"
        class="mobile-slide-board-backdrop ${state.slideBoardOpen ? 'open' : ''}"
        data-toggle-slide-board="true"
        aria-label="Đóng bảng nhanh"
      ></button>

      <section class="mobile-slide-board ${state.slideBoardOpen ? 'open' : ''}" aria-hidden="${state.slideBoardOpen ? 'false' : 'true'}">
        ${quickBoardMarkup}
      </section>

      <button
        type="button"
        class="menu-backdrop ${state.sidebarOpen ? 'open' : ''}"
        data-toggle-menu="true"
        aria-label="Đóng menu"
      ></button>

      <section class="content">
        <header class="content-header">
          <div class="content-header-left">
            <button
              type="button"
              class="menu-toggle ${state.sidebarOpen ? '' : 'closed'}"
              data-toggle-menu="true"
              aria-label="Ẩn hoặc hiện menu trái"
              aria-expanded="${state.sidebarOpen ? 'true' : 'false'}"
            >
              <span></span>
              <span></span>
              <span></span>
            </button>
            <p class="route-pill">${routeTitleMap[state.route] || 'Học tiếng Anh cùng Hồng Nga'}</p>
          </div>
          <p class="muted">Dữ liệu đang truy xuất từ backend SQLite.</p>
        </header>
        ${content}
      </section>

      ${state.resultNotice
        ? `
          <div class="result-overlay" data-close-result="true">
            <section class="result-dialog" role="dialog" aria-modal="true" aria-label="Thông báo kết quả">
              <h3>${escapeHtml(state.resultNotice.title)}</h3>
              <p>${escapeHtml(state.resultNotice.message)}</p>
              ${state.resultNotice.type === 'mcq' ? '<button type="button" class="small-btn" data-open-mcq-review>Xem lại đúng/sai</button>' : ''}
              ${state.resultNotice.type === 'mcq' ? '<button type="button" class="small-btn" data-retry-mcq>Random bộ mới</button>' : ''}
              <button type="button" class="action-btn" data-close-result="true">Đóng</button>
            </section>
          </div>
        `
        : ''}
    </main>
  `
}

function renderLandingPage() {
  return `
    <main class="landing-shell">
      <section class="landing-card">
        <img
          class="brand-logo landing-logo"
          src="/logo.jpg"
          alt="Logo Học tiếng Anh cùng Hồng Nga"
          onerror="this.style.display='none'"
        />
        <p class="landing-eyebrow">Học tiếng Anh cùng Hồng Nga</p>
        <h1>Luyện tiếng Anh 5 cùng Hồng Nga</h1>
        <p class="landing-subtitle">Bắt đầu nhanh với bộ bài tập và trang quản lý dữ liệu học tập.</p>
        <div class="landing-actions">
          <button type="button" class="action-btn" data-route="/exercise/mcq">Vào luyện tập</button>
          <button type="button" class="small-btn" data-route="/source/vocab">Quản lý nguồn dữ liệu</button>
        </div>
      </section>
    </main>
  `
}

async function refreshDatabase(options = {}) {
  const { force = false } = options

  if (!force) {
    const cached = getCachedDatabaseEntry()
    if (cached) {
      state.database = cloneDatabasePayload(cached.data)
      return
    }
  }

  let payload
  if (state.route === '/exercise/mcq') {
    payload = await fetchDatabase({
      mcqMode: state.mcqSourceMode,
      fresh: force,
    })
  } else {
    payload = await fetchDatabase({ fresh: force })
  }

  state.database = payload
  saveDatabaseCache(payload)
}

async function loadDataForCurrentRoute() {
  if (state.route === '/home') {
    state.loading = false
    state.serverError = ''
    render()
    return
  }

  const hasFreshCache = Boolean(getCachedDatabaseEntry())
  state.loading = !hasFreshCache
  state.serverError = ''
  if (state.loading) render()

  try {
    await refreshDatabase()
    resetExerciseState()
  } catch (error) {
    state.serverError = error.message || 'Không truy vấn được dữ liệu từ cơ sở dữ liệu.'
  }

  state.loading = false
  render()
}

async function withRefresh(action, successMessage) {
  try {
    await action()
    clearDatabaseCache()
    await refreshDatabase({ force: true })
    resetExerciseState()
    state.sourceMessage = successMessage
    state.sourceMessageType = 'ok'
  } catch (error) {
    state.sourceMessage = error.message || 'Có lỗi khi thao tác dữ liệu.'
    state.sourceMessageType = 'error'
  }
  render()
}

function renderHome() {
  const vocabCount = state.database.vocabulary.length
  const mcqCount = getMcqExerciseItems().length
  const matchingCount = state.database.questions.matching.length
  const blankCount = state.database.questions.fillBlank.length
  const writingCount = state.database.questions.writing.length
  const listingCount = (state.database.questions.listing || []).length

  return `
    <section class="page-card">
      <h2>Học tiếng Anh cùng Hồng Nga</h2>
      <p>Chọn tính năng ở menu bên trái. Mỗi bài tập sẽ được chấm dựa trên dữ liệu đang lưu trong cơ sở dữ liệu.</p>
      <div class="stat-grid">
        <article><strong>${vocabCount}</strong><span>Từ vựng</span></article>
        <article><strong>${mcqCount}</strong><span>Câu trắc nghiệm</span></article>
        <article><strong>${matchingCount}</strong><span>Cặp nối từ</span></article>
        <article><strong>${blankCount}</strong><span>Câu điền trống</span></article>
        <article><strong>${writingCount}</strong><span>Đề viết</span></article>
        <article><strong>${listingCount}</strong><span>Câu hỏi liệt kê</span></article>
      </div>
    </section>
  `
}

function renderMcqPage() {
  const questions = state.mcqQuizQuestions
  const score = scoreMcq()
  const answeredCount = state.mcqAnswers.filter((answer) => String(answer || '').trim().length > 0).length
  const availableCount = state.mcqPoolQuestions.length
  const hiddenCorrectCount = state.mcqCorrectQuestionIds.length
  const selectedCount = Math.min(state.mcqQuestionCount, availableCount)
  const modeLabel =
    state.mcqSourceMode === 'vocabulary'
      ? 'Kiểm tra nghĩa từ vựng'
      : state.mcqSourceMode === 'question'
        ? 'Câu hỏi + câu trả lời'
        : 'Mix cả 2 loại'
  const setupVisible = state.mcqSessionPhase !== 'playing'
  const sessionCompleted = state.mcqSessionPhase === 'completed'
  const inPlay = state.mcqSessionPhase === 'playing'
  const currentQuestion = questions[state.mcqCurrentIndex]
  const canSubmit = inPlay && questions.length > 0 && answeredCount === questions.length

  const setupPanel = setupVisible
    ? `
      <section class="question-card mcq-setup-card">
        <h3 class="question-title">
          <span class="question-order">Thiết lập trắc nghiệm</span>
          <span class="question-text">Chọn loại và số câu trước khi bắt đầu</span>
        </h3>
        <label>
          Loại trắc nghiệm
          <select data-mcq-source-mode>
            <option value="vocabulary" ${state.mcqSourceMode === 'vocabulary' ? 'selected' : ''}>Kiểm tra nghĩa từ vựng</option>
            <option value="question" ${state.mcqSourceMode === 'question' ? 'selected' : ''}>Câu hỏi + câu trả lời</option>
            <option value="mix" ${state.mcqSourceMode === 'mix' ? 'selected' : ''}>Mix cả 2 loại</option>
          </select>
        </label>
        <label>
          Số lượng câu hỏi
          <select data-mcq-question-count>
            <option value="5" ${state.mcqQuestionCount === 5 ? 'selected' : ''}>5 câu</option>
            <option value="10" ${state.mcqQuestionCount === 10 ? 'selected' : ''}>10 câu</option>
            <option value="15" ${state.mcqQuestionCount === 15 ? 'selected' : ''}>15 câu</option>
          </select>
        </label>
        <label class="inline-check">
          <input type="checkbox" data-mcq-exclude-correct ${state.mcqExcludeCorrectEnabled ? 'checked' : ''} />
          <span>Không lấy câu đã làm đúng</span>
        </label>
        <p class="muted">Đã ghi nhận đúng: <strong>${hiddenCorrectCount}</strong> câu.</p>
        <button type="button" class="small-btn" data-mcq-clear-correct ${hiddenCorrectCount ? '' : 'disabled'}>Hiển thị lại câu đã đúng</button>
        <p class="muted">Chế độ hiện tại: ${modeLabel}. Tối đa có thể lấy: <strong>${availableCount}</strong> câu.</p>
        <button type="button" class="action-btn" data-mcq-start ${availableCount ? '' : 'disabled'}>Bắt đầu làm bài</button>
        ${sessionCompleted
          ? `
            <div class="mcq-complete-actions">
              <button type="button" class="small-btn" data-mcq-retry-wrong ${state.mcqWrongQuestions.length ? '' : 'disabled'}>Làm lại câu sai (${state.mcqWrongQuestions.length})</button>
              <button type="button" class="small-btn" data-mcq-retry>Random bộ mới</button>
            </div>
          `
          : ''}
      </section>
    `
    : ''

  const playPanel = inPlay && currentQuestion
    ? `
      <section class="question-card">
        <h3 class="question-title">
          <span class="question-order">Câu ${state.mcqCurrentIndex + 1}/${questions.length}</span>
          <span class="question-text">${escapeHtml(currentQuestion.question)}</span>
        </h3>
        <p class="muted">Đã trả lời: <strong>${answeredCount}/${questions.length}</strong> câu. Bạn có thể quay lại câu trước để sửa đáp án.</p>
        <div class="option-grid">
          ${currentQuestion.options
            .map(
              (option) => `
                <label class="option-row ${state.mcqAnswers[state.mcqCurrentIndex] === option ? 'selected' : ''}">
                  <input type="radio" name="mcq-current" value="${escapeHtml(option)}" ${state.mcqAnswers[state.mcqCurrentIndex] === option ? 'checked' : ''} />
                  <span>${escapeHtml(option)}</span>
                </label>
              `,
            )
            .join('')}
        </div>
        <div class="mcq-complete-actions">
          <button type="button" class="small-btn" data-mcq-prev ${state.mcqCurrentIndex > 0 ? '' : 'disabled'}>Câu trước</button>
          <button type="button" class="small-btn" data-mcq-next ${state.mcqCurrentIndex + 1 < questions.length ? '' : 'disabled'}>Câu kế tiếp</button>
        </div>
        ${canSubmit
          ? '<button type="button" class="action-btn" data-check-result="mcq">Kiểm tra kết quả</button>'
          : '<p class="muted">Nút kiểm tra kết quả sẽ xuất hiện khi bạn trả lời hết tất cả câu hỏi.</p>'}
      </section>
    `
    : ''

  const reviewPanel = sessionCompleted
    ? `
      <section class="question-card mcq-review-card">
        <h3 class="question-title">
          <span class="question-order">Đã hoàn thành</span>
          <span class="question-text">Bạn làm đúng ${score}/${questions.length} câu</span>
        </h3>
        <div class="mcq-complete-actions">
          <button type="button" class="small-btn" data-mcq-retry-wrong ${state.mcqWrongQuestions.length ? '' : 'disabled'}>Làm lại câu sai (${state.mcqWrongQuestions.length})</button>
          <button type="button" class="small-btn" data-mcq-retry>Random bộ mới</button>
        </div>
      </section>
      ${state.mcqReviewOpen
        ? questions
          .map((item, index) => {
            const selectedAnswer = state.mcqAnswers[index]
            const options = item.options
              .map((option) => {
                const isCorrectOption = option === item.answer
                const isSelectedOption = selectedAnswer === option

                let reviewClass = ''
                if (isCorrectOption) reviewClass = 'review-correct'
                if (isSelectedOption && !isCorrectOption) reviewClass = 'review-wrong-selected'

                return `
                  <div class="option-row review-option ${reviewClass}">
                    <span class="option-marker">${isCorrectOption ? '✓' : isSelectedOption ? '✗' : '•'}</span>
                    <span>${escapeHtml(option)}</span>
                  </div>
                `
              })
              .join('')

            return `
              <article class="question-card">
                <h3 class="question-title">
                  <span class="question-order">Câu ${index + 1}/${questions.length}</span>
                  <span class="question-text">${escapeHtml(item.question)}</span>
                </h3>
                <div class="option-grid review-grid">${options}</div>
              </article>
            `
          })
          .join('')
        : ''}
    `
    : ''

  return `
    <section class="page-card">
      <h2>Trắc nghiệm</h2>
      ${setupPanel}
      ${playPanel}
      ${reviewPanel}
      ${sessionCompleted ? `<p class="score-line">Điểm: <strong>${score}/${questions.length}</strong></p>` : ''}
      ${inPlay ? '<button type="button" class="small-btn" data-mcq-retry>Random bộ mới</button>' : ''}
    </section>
  `
}

function renderMatchingPage() {
  const items = state.database.questions.matching
  const { leftColumn, rightColumn } = getMatchingSessionItems()
  const score = scoreMatching()
  const maxSelectable = Math.min(10, Math.max(1, items.length || 1))
  const selectedCount = Math.min(maxSelectable, Math.max(1, state.matchingQuestionCount || 1))
  const isComplete = isMatchingRoundComplete()
  const selectedLeftId = Number(state.matchingSelectedLeftId)
  const rightOwnershipMap = Object.entries(state.matchingPairs).reduce((map, [leftId, rightId]) => {
    map[String(rightId)] = Number(leftId)
    return map
  }, {})

  return `
    <section class="page-card">
      <h2>Nối từ</h2>
      <article class="question-card compact">
        <label>
          Số lượng cặp từ muốn nối
          <select data-matching-question-count>
            ${Array.from({ length: maxSelectable }, (_, index) => index + 1)
      .map((value) => `<option value="${value}" ${selectedCount === value ? 'selected' : ''}>${value} cặp</option>`)
      .join('')}
          </select>
        </label>
        <button type="button" class="small-btn" data-matching-reset-session>Random bộ nối mới</button>
      </article>

      ${leftColumn.length
      ? `
          <article class="question-card">
            <p class="muted">Bấm 1 từ ở cột A, sau đó bấm 1 từ ở cột B để nối.</p>
            <div class="matching-board">
              <section class="matching-column">
                <h3>Cột A</h3>
                ${leftColumn
      .map((item) => {
        const matchedRightId = Number(state.matchingPairs[item.id])
        const isSelected = selectedLeftId === Number(item.id)
        const isMatched = matchedRightId > 0
        const isCorrect = state.matchingChecked && matchedRightId === Number(item.id)
        const isWrong = state.matchingChecked && isMatched && matchedRightId !== Number(item.id)

        return `
                      <button
                        type="button"
                        class="matching-item left ${isSelected ? 'selected' : ''} ${isMatched ? 'matched' : ''} ${isCorrect ? 'correct' : ''} ${isWrong ? 'wrong' : ''}"
                        data-match-left="${item.id}"
                      >
                        ${escapeHtml(item.word)}
                      </button>
                    `
      })
      .join('')}
              </section>

              <section class="matching-column">
                <h3>Cột B</h3>
                ${rightColumn
      .map((item) => {
        const ownerLeftId = Number(rightOwnershipMap[String(item.id)] || 0)
        const isTaken = ownerLeftId > 0
        const isSelectedLink = isTaken && ownerLeftId === selectedLeftId
        const isCorrect = state.matchingChecked && isTaken && ownerLeftId === Number(item.id)
        const isWrong = state.matchingChecked && isTaken && ownerLeftId !== Number(item.id)

        return `
                      <button
                        type="button"
                        class="matching-item right ${isTaken ? 'matched' : ''} ${isSelectedLink ? 'selected-link' : ''} ${isCorrect ? 'correct' : ''} ${isWrong ? 'wrong' : ''}"
                        data-match-right="${item.id}"
                      >
                        ${escapeHtml(item.meaning)}
                      </button>
                    `
      })
      .join('')}
              </section>
            </div>
          </article>

          <p class="score-line">Đã nối: <strong>${Object.keys(state.matchingPairs).length}/${leftColumn.length}</strong> cặp</p>
          ${isComplete ? '<button type="button" class="action-btn" data-matching-check-result>Kiểm tra kết quả</button>' : '<p class="muted">Nối đủ tất cả cặp để hiện nút kiểm tra kết quả.</p>'}
          ${state.matchingChecked ? `<p class="score-line">Kết quả: <strong>${score}/${leftColumn.length}</strong> cặp đúng</p>` : ''}
        `
      : '<p class="muted">Chưa có dữ liệu từ nối nào.</p>'}
    </section>
  `
}

function renderFillPage() {
  const items = state.database.questions.fillBlank
  const score = scoreBlanks()

  return `
    <section class="page-card">
      <h2>Điền chỗ trống</h2>
      ${items
        .map(
          (item, index) => `
            <article class="question-card compact">
              <p class="question-text">${escapeHtml(item.sentence).replace('___', '<span class="blank-mark">_____</span>')}</p>
              <input data-blank-index="${index}" type="text" value="${escapeHtml(state.blankAnswers[index] || '')}" placeholder="Nhập đáp án" />
            </article>
          `,
        )
        .join('')}
      <p class="score-line">Điểm: <strong>${score}/${items.length}</strong></p>
      <button type="button" class="action-btn" data-check-result="fillBlank">Kiểm tra kết quả</button>
    </section>
  `
}

function renderWritingPage() {
  const items = state.database.questions.writing
  const scores = scoreWriting()
  const correctCount = getWritingCorrectCount(scores)

  return `
    <section class="page-card">
      <h2>Viết định nghĩa</h2>
      ${items
        .map(
          (item, index) => `
            <article class="question-card">
              <h3 class="question-title">
                <span class="question-order">Từ cần định nghĩa</span>
                <span class="question-text">${escapeHtml(item.word)}</span>
              </h3>
              <p class="question-hint">${escapeHtml(item.hint)}</p>
              <p class="muted">Mỗi dòng là 1 ý/1 đáp án. Có thể dùng -, *, hoặc số thứ tự. Không cần đúng thứ tự.</p>
              <textarea data-writing-index="${index}" rows="5" placeholder="- Ý 1&#10;- Ý 2&#10;- Ý 3">${escapeHtml(state.writingAnswers[index] || '')}</textarea>
              <p class="muted">Độ khớp theo dòng: <strong>${scores[index].percent}%</strong> (${scores[index].hitCount}/${scores[index].total})</p>
            </article>
          `,
        )
        .join('')}
      <p class="score-line">Câu đạt yêu cầu (>= 60%): <strong>${correctCount}/${items.length}</strong></p>
      <button type="button" class="action-btn" data-check-result="writing">Kiểm tra kết quả</button>
    </section>
  `
}

function renderListingPage() {
  const items = state.database.questions.listing || []
  const scores = scoreListing()
  const sessionIndexes = state.listingSessionIndexes || []
  const correctCount = getListingCorrectCount(scores, sessionIndexes)
  const listingThresholdPercent = Math.round(LISTING_MATCH_THRESHOLD * 100)
  const totalCount = sessionIndexes.length
  const currentIndex = Math.max(0, Math.min(state.listingCurrentIndex, Math.max(totalCount - 1, 0)))
  const activeQuestionIndex = sessionIndexes[currentIndex] ?? 0
  const currentItem = items[activeQuestionIndex]
  const currentScore = scores[activeQuestionIndex] || { percent: 0, hitCount: 0, total: 0, ideaDetails: [] }
  const currentChecked = Boolean(state.listingCheckedMap[activeQuestionIndex])
  const checkedCount = sessionIndexes.filter((index) => state.listingCheckedMap[index]).length
  const allChecked = totalCount > 0 && checkedCount === totalCount
  const maxSelectable = Math.min(5, Math.max(1, items.length || 1))
  const currentSelectable = Math.min(maxSelectable, Math.max(1, state.listingQuestionCount || 1))

  return `
    <section class="page-card">
      <h2>Liệt kê ý</h2>
      <article class="question-card compact">
        <label>
          Số lượng câu liệt kê (1-5)
          <select data-listing-question-count>
            ${Array.from({ length: maxSelectable }, (_, index) => index + 1)
      .map((value) => `<option value="${value}" ${currentSelectable === value ? 'selected' : ''}>${value} câu</option>`)
      .join('')}
          </select>
        </label>
        <button type="button" class="small-btn" data-listing-reset-session>Random bộ câu mới</button>
      </article>
      ${currentItem
      ? `
            <article class="question-card">
              <h3 class="question-title">
                <span class="question-order">Câu ngẫu nhiên (${checkedCount}/${totalCount} đã kiểm tra)</span>
                <span class="question-text">${escapeHtml(currentItem.prompt)}</span>
              </h3>
              <p class="question-hint">${escapeHtml(currentItem.hint || 'Liệt kê các ý theo từng dòng.')}</p>
              <p class="muted">Mỗi dòng là 1 ý. Không cần đúng thứ tự.</p>
              <textarea data-listing-index="${activeQuestionIndex}" rows="6" placeholder="- Ý 1&#10;- Ý 2&#10;- Ý 3">${escapeHtml(state.listingAnswers[activeQuestionIndex] || '')}</textarea>
              <p class="muted">Độ khớp theo dòng: <strong>${currentScore.percent}%</strong> (${currentScore.hitCount}/${currentScore.total})</p>
              ${currentChecked
      ? `
                <div class="listing-review-block">
                  <p class="muted"><strong>Đáp án đúng và đối chiếu chi tiết:</strong></p>
                  ${(currentScore.ideaDetails || [])
      .map((detail) => `
                      <article class="listing-review-item ${detail.isCorrect ? 'ok' : 'wrong'}">
                        <p><strong>Ý chuẩn:</strong> ${escapeHtml(detail.expected)}</p>
                        <p><strong>Bạn trả lời:</strong> ${escapeHtml(detail.user || '(chưa có ý phù hợp)')}</p>
                        <p class="muted">Khớp từ: ${detail.matchedCount}/${detail.totalWords} (${detail.matchPercent}%)</p>
                        <p class="muted">Từ chi tiết: ${detail.words
            .map((word) => (word.matched ? `✓ ${word.word}` : `✗ ${word.word}`))
            .map((item) => escapeHtml(item))
            .join(' · ')}</p>
                      </article>
                    `)
      .join('')}
                </div>
              `
      : ''}
            </article>
            ${currentChecked
      ? `
              <div class="mcq-complete-actions">
                ${!allChecked ? '<button type="button" class="action-btn" data-listing-next-question>Qua câu ngẫu nhiên tiếp theo</button>' : ''}
                ${allChecked ? '<button type="button" class="small-btn" data-check-result="listing">Xem tổng kết</button>' : ''}
              </div>
            `
      : '<button type="button" class="action-btn" data-listing-check-current>Kiểm tra câu hiện tại</button>'}
          `
      : '<p class="muted">Chưa có câu hỏi liệt kê nào.</p>'}
      <p class="score-line">Đã kiểm tra: <strong>${checkedCount}/${totalCount}</strong> câu</p>
      <p class="score-line">Câu đạt yêu cầu (>= ${listingThresholdPercent}%): <strong>${correctCount}/${totalCount}</strong></p>
    </section>
  `
}

function renderSourceMatching() {
  const matchingList = state.database.questions.matching || []

  return `
    <section class="page-card">
      <h2>Nhiệm vụ: Thêm từ nối</h2>
      <form id="matching-form" class="stack-form">
        <p class="muted">Thêm cặp từ nối theo 2 cột A và B để dùng cho bài tập nối từ.</p>
        <label>Từ cột A<input name="word" required placeholder="diligent" /></label>
        <label>Từ cột B<input name="meaning" required placeholder="hard-working and careful" /></label>
        <button type="submit">Lưu từ nối vào cơ sở dữ liệu</button>
      </form>

      <h3>Quản lý từ nối (sửa/xóa)</h3>
      <div class="manage-list">
        ${matchingList.length
          ? matchingList
            .map(
              (item) => `
                <article class="manage-card">
                  <div>
                    <p><strong>Cột A:</strong> ${escapeHtml(item.word)}</p>
                    <p><strong>Cột B:</strong> ${escapeHtml(item.meaning)}</p>
                  </div>
                  <div class="row-actions">
                    <button class="small-btn" data-edit-source-matching="${item.id}">Sửa</button>
                    <button class="small-btn danger" data-delete-source-matching="${item.id}">Xóa</button>
                  </div>
                </article>
              `,
            )
            .join('')
          : '<p class="muted">Chưa có cặp từ nối nào.</p>'}
      </div>

      ${renderSourceMessage()}
    </section>
  `
}

function renderSourceVocab() {
  return `
    <section class="page-card">
      <h2>Nhiệm vụ: Thêm từ vựng</h2>
      <form id="vocab-form" class="stack-form">
        <label>Từ<input name="word" required placeholder="resilient" /></label>
        <label>Định nghĩa<input name="definition" required placeholder="Có khả năng phục hồi nhanh..." /></label>
        <label>Ví dụ<input name="example" placeholder="Một học sinh kiên cường luôn tiếp tục học hỏi." /></label>
        <button type="submit">Lưu vào cơ sở dữ liệu</button>
      </form>

      <h3>Quản lý từ vựng (sửa/xóa)</h3>
      <div class="manage-list">
        ${state.database.vocabulary
          .map(
            (item) => `
              <article class="manage-card">
                <div>
                  <strong>${escapeHtml(item.word)}</strong>
                  <p>${escapeHtml(item.definition)}</p>
                </div>
                <div class="row-actions">
                  <button class="small-btn" data-edit-vocab="${item.id}">Sửa</button>
                  <button class="small-btn danger" data-delete-vocab="${item.id}">Xóa</button>
                </div>
              </article>
            `,
          )
          .join('')}
      </div>
      ${renderSourceMessage()}
    </section>
  `
}

function renderManagedQuestions() {
  const type = state.manageQuestionType
  const list = state.database.questions[type]
  if (!list.length) {
    return '<p class="muted">Chưa có câu hỏi nào.</p>'
  }

  return list
    .map((item) => {
      if (type === 'mcq') {
        const modeLabel = item.mode === 'vocabulary_definition' ? 'Từ vựng - định nghĩa' : 'Trắc nghiệm thường'
        return `
          <article class="manage-card">
            <div>
              <strong>${escapeHtml(item.question)}</strong>
              <p class="muted">Loại: ${escapeHtml(modeLabel)}</p>
              <p class="muted">Hệ thống tự tạo phương án nhiễu từ đáp án của câu khác.</p>
              <p class="muted">Đáp án: ${escapeHtml(item.answer)}</p>
            </div>
            <div class="row-actions">
              <button class="small-btn" data-edit-question="${type}:${item.id}">Sửa</button>
              <button class="small-btn danger" data-delete-question="${type}:${item.id}">Xóa</button>
            </div>
          </article>
        `
      }

      if (type === 'matching') {
        return `
          <article class="manage-card">
            <div>
              <strong>${escapeHtml(item.word)}</strong>
              <p>${escapeHtml(item.meaning)}</p>
            </div>
            <div class="row-actions">
              <button class="small-btn" data-edit-question="${type}:${item.id}">Sửa</button>
              <button class="small-btn danger" data-delete-question="${type}:${item.id}">Xóa</button>
            </div>
          </article>
        `
      }

      if (type === 'fillBlank') {
        return `
          <article class="manage-card">
            <div>
              <strong>${escapeHtml(item.sentence)}</strong>
              <p class="muted">Đáp án: ${escapeHtml(item.answer)}</p>
            </div>
            <div class="row-actions">
              <button class="small-btn" data-edit-question="${type}:${item.id}">Sửa</button>
              <button class="small-btn danger" data-delete-question="${type}:${item.id}">Xóa</button>
            </div>
          </article>
        `
      }

      return `
        <article class="manage-card">
          <div>
            <strong>${escapeHtml(item.word)}</strong>
            <p>${escapeHtml(item.hint)}</p>
            <p class="muted">Đáp án mẫu theo dòng: ${escapeHtml(item.keywords.join(' | '))}</p>
          </div>
          <div class="row-actions">
            <button class="small-btn" data-edit-question="${type}:${item.id}">Sửa</button>
            <button class="small-btn danger" data-delete-question="${type}:${item.id}">Xóa</button>
          </div>
        </article>
      `
    })
    .join('')
}

function renderSourceQuestion() {
  const questionAnswerList = state.database.questions.mcq || []
  const writingQuestionList = (state.database.questions.writing || []).map((item) => ({
    id: item.id,
    questionType: 'writing',
    prompt: item.word,
    hint: item.hint,
    answers: item.keywords || [],
  }))
  const listingQuestionList = (state.database.questions.listing || []).map((item) => ({
    id: item.id,
    questionType: 'listing',
    prompt: item.prompt,
    hint: item.hint,
    answers: item.answers || [],
  }))
  const sharedListQuestions = [...writingQuestionList, ...listingQuestionList]
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))

  return `
    <section class="page-card">
      <h2>Nhiệm vụ: Thêm câu hỏi + câu trả lời</h2>
      <form id="question-form" class="stack-form">
        <p class="muted">Nhập câu hỏi và đáp án để lưu vào cơ sở dữ liệu câu hỏi.</p>
        <label>Câu hỏi<input name="question" required placeholder="Ví dụ: Nghĩa của từ resilient là gì?" /></label>
        <label>Đáp án đúng<input name="answer" required placeholder="Có khả năng phục hồi nhanh sau khó khăn" /></label>
        <button type="submit">Lưu câu hỏi vào cơ sở dữ liệu</button>
      </form>

      <h3>Câu hỏi liệt kê (dùng chung cho Viết và Liệt kê)</h3>
      <form id="shared-list-question-form" class="stack-form">
        <label>
          Dùng cho bài tập
          <select name="targetType" required>
            <option value="listing">Liệt kê ý</option>
            <option value="writing">Viết định nghĩa</option>
          </select>
        </label>
        <label>Nội dung câu hỏi / từ cần định nghĩa<input name="prompt" required placeholder="Liệt kê 3 lợi ích của việc đọc sách hoặc từ resilient" /></label>
        <label>Gợi ý<input name="hint" placeholder="Mỗi dòng một ý ngắn" /></label>
        <label>
          Đáp án mẫu theo dòng
          <textarea name="answersText" rows="5" required placeholder="- Ý 1&#10;- Ý 2&#10;- Ý 3"></textarea>
        </label>
        <button type="submit">Lưu câu hỏi liệt kê</button>
      </form>

      <h3>Quản lý câu hỏi/câu trả lời (sửa/xóa)</h3>
      <div class="manage-list">
        ${questionAnswerList.length
          ? questionAnswerList
            .map(
              (item) => `
                <article class="manage-card">
                  <div>
                    <strong>${escapeHtml(item.question)}</strong>
                    <p class="muted">Đáp án: ${escapeHtml(item.answer)}</p>
                  </div>
                  <div class="row-actions">
                    <button class="small-btn" data-edit-question-answer="${item.id}">Sửa</button>
                    <button class="small-btn danger" data-delete-question-answer="${item.id}">Xóa</button>
                  </div>
                </article>
              `,
            )
            .join('')
          : '<p class="muted">Chưa có câu hỏi/câu trả lời nào.</p>'}
      </div>

      <h3>Quản lý câu hỏi liệt kê dùng chung (sửa/xóa)</h3>
      <div class="manage-list">
        ${sharedListQuestions.length
          ? sharedListQuestions
            .map(
              (item) => `
                <article class="manage-card">
                  <div>
                    <strong>${escapeHtml(item.prompt)}</strong>
                    <p>${escapeHtml(item.hint)}</p>
                    <p class="muted">Dùng cho: ${item.questionType === 'writing' ? 'Viết định nghĩa' : 'Liệt kê ý'}</p>
                    <p class="muted">Đáp án mẫu theo dòng: ${escapeHtml((item.answers || []).join(' | '))}</p>
                  </div>
                  <div class="row-actions">
                    <button class="small-btn" data-edit-shared-list-question="${item.questionType}:${item.id}">Sửa</button>
                    <button class="small-btn danger" data-delete-shared-list-question="${item.questionType}:${item.id}">Xóa</button>
                  </div>
                </article>
              `,
            )
            .join('')
          : '<p class="muted">Chưa có câu hỏi liệt kê dùng chung nào.</p>'}
      </div>

      ${renderSourceMessage()}
    </section>
  `
}

function renderSourceMessage() {
  if (!state.sourceMessage) return ''
  return `<p class="notice ${state.sourceMessageType}">${escapeHtml(state.sourceMessage)}</p>`
}

function renderCurrentPage() {
  if (state.route === '/home') return renderLandingPage()
  if (state.route === '/exercise/mcq') return renderLayout(renderMcqPage())
  if (state.route === '/exercise/matching') return renderLayout(renderMatchingPage())
  if (state.route === '/exercise/fill') return renderLayout(renderFillPage())
  if (state.route === '/exercise/writing') return renderLayout(renderWritingPage())
  if (state.route === '/exercise/listing') return renderLayout(renderListingPage())
  if (state.route === '/source/vocab') return renderLayout(renderSourceVocab())
  if (state.route === '/source/questions') return renderLayout(renderSourceQuestion())
  if (state.route === '/source/matching') return renderLayout(renderSourceMatching())
  return renderLandingPage()
}

function attachNavEvents() {
  document.querySelectorAll('[data-route]').forEach((button) => {
    button.addEventListener('click', async () => {
      const route = button.dataset.route
      if (!route) return

      state.slideBoardOpen = false

      if (window.innerWidth <= 980 && state.sidebarOpen) {
        state.sidebarOpen = false
        window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(state.sidebarOpen))
      }

      if (state.route === route) {
        await loadDataForCurrentRoute()
        return
      }

      setRoute(route)
    })
  })

  document.querySelectorAll('[data-toggle-slide-board]').forEach((button) => {
    button.addEventListener('click', () => {
      const isMobile = window.innerWidth <= 980
      if (isMobile && !state.slideBoardOpen) {
        state.slideBoardOpen = true
        state.sidebarOpen = false
        window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(state.sidebarOpen))
        render()
        return
      }

      state.slideBoardOpen = !state.slideBoardOpen
      render()
    })
  })

  document.querySelectorAll('[data-toggle-source-group]').forEach((button) => {
    button.addEventListener('click', () => {
      state.sourceGroupOpen = !state.sourceGroupOpen
      render()
    })
  })

  document.querySelectorAll('[data-toggle-menu]').forEach((button) => {
    button.addEventListener('click', () => {
      state.sidebarOpen = !state.sidebarOpen
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(state.sidebarOpen))
      state.slideBoardOpen = false
      render()
    })
  })
}

function attachExerciseEvents() {
  if (exerciseEventsBound) return
  exerciseEventsBound = true

  app.addEventListener('change', async (event) => {
    const target = event.target

    if (target.matches('input[type="radio"]')) {
      if (state.mcqReviewOpen || state.mcqSessionPhase !== 'playing') return
      if (target.name !== 'mcq-current') return

      state.mcqAnswers[state.mcqCurrentIndex] = target.value
      scheduleRender()
      return
    }

    if (target.matches('[data-listing-question-count]')) {
      const nextValue = Number(target.value) || 1
      state.listingQuestionCount = Math.min(5, Math.max(1, nextValue))
      resetListingSession((state.database.questions.listing || []).length)
      render()
      return
    }

    if (target.matches('[data-matching-question-count]')) {
      const nextValue = Number(target.value) || 1
      state.matchingQuestionCount = Math.min(10, Math.max(1, nextValue))
      resetMatchingSession((state.database.questions.matching || []).length)
      render()
      return
    }

    if (target.matches('[data-mcq-source-mode]')) {
      state.mcqSourceMode = target.value
      await loadDataForCurrentRoute()
      return
    }

    if (target.matches('[data-mcq-question-count]')) {
      state.mcqQuestionCount = Number(target.value) || 5
      render()
      return
    }

    if (target.matches('[data-mcq-exclude-correct]')) {
      state.mcqExcludeCorrectEnabled = Boolean(target.checked)
      prepareMcqPool()
      render()
    }
  })

  app.addEventListener('input', (event) => {
    const target = event.target

    if (target.matches('input[data-blank-index]')) {
      state.blankAnswers[Number(target.dataset.blankIndex)] = target.value
      scheduleRender()
      return
    }

    if (target.matches('textarea[data-writing-index]')) {
      state.writingAnswers[Number(target.dataset.writingIndex)] = target.value
      state.writingScoreDirty = true
      return
    }

    if (target.matches('textarea[data-listing-index]')) {
      const index = Number(target.dataset.listingIndex)
      state.listingAnswers[index] = target.value
      state.listingCheckedMap[index] = false
      state.listingScoreDirty = true
    }
  })

  app.addEventListener('focusout', (event) => {
    const target = event.target

    if (target.matches('textarea[data-writing-index]')) {
      state.writingAnswers[Number(target.dataset.writingIndex)] = target.value
      render()
      return
    }

    if (target.matches('textarea[data-listing-index]')) {
      state.listingAnswers[Number(target.dataset.listingIndex)] = target.value
      render()
    }
  })

  app.addEventListener('click', (event) => {
    const target = event.target
    const button = target.closest('button')

    if (button?.matches('[data-mcq-prev]')) {
      if (state.mcqCurrentIndex <= 0) return
      state.mcqCurrentIndex -= 1
      state.mcqNextPromptOpen = false
      render()
      return
    }

    if (button?.matches('[data-mcq-next]')) {
      if (state.mcqCurrentIndex + 1 >= state.mcqQuizQuestions.length) return
      state.mcqCurrentIndex += 1
      state.mcqNextPromptOpen = false
      render()
      return
    }

    if (button?.matches('[data-listing-check-current]')) {
      const activeIndex = state.listingSessionIndexes[state.listingCurrentIndex] ?? 0
      state.listingCheckedMap[activeIndex] = true
      render()
      return
    }

    if (button?.matches('[data-listing-next-question]')) {
      const uncheckedIndexes = state.listingSessionIndexes
        .filter((index) => !state.listingCheckedMap[index])

      if (!uncheckedIndexes.length) return

      const randomIndex = Math.floor(Math.random() * uncheckedIndexes.length)
      const nextQuestionIndex = uncheckedIndexes[randomIndex]
      state.listingCurrentIndex = state.listingSessionIndexes.findIndex((index) => index === nextQuestionIndex)
      render()
      return
    }

    if (button?.matches('[data-listing-reset-session]')) {
      resetListingSession((state.database.questions.listing || []).length)
      render()
      return
    }

    if (button?.matches('[data-matching-reset-session]')) {
      resetMatchingSession((state.database.questions.matching || []).length)
      render()
      return
    }

    if (button?.matches('[data-match-left]')) {
      const leftId = Number(button.dataset.matchLeft)
      if (!leftId) return
      state.matchingSelectedLeftId = leftId
      render()
      return
    }

    if (button?.matches('[data-match-right]')) {
      const rightId = Number(button.dataset.matchRight)
      const selectedLeftId = Number(state.matchingSelectedLeftId)
      if (!rightId || !selectedLeftId) return

      Object.entries(state.matchingPairs).forEach(([leftId, linkedRightId]) => {
        if (Number(leftId) !== selectedLeftId && Number(linkedRightId) === rightId) {
          delete state.matchingPairs[leftId]
        }
      })

      state.matchingPairs[selectedLeftId] = rightId
      state.matchingChecked = false

      const nextUnmatchedLeftId = state.matchingSessionIds
        .map((id) => Number(id))
        .find((leftId) => !Number(state.matchingPairs[leftId]))
      state.matchingSelectedLeftId = nextUnmatchedLeftId || selectedLeftId

      render()
      return
    }

    if (button?.matches('[data-matching-check-result]')) {
      if (!isMatchingRoundComplete()) return
      state.matchingChecked = true
      render()
      return
    }

    if (button?.matches('[data-mcq-start]')) {
      state.resultNotice = null
      startMcqQuizRound()
      render()
      return
    }

    if (button?.matches('[data-mcq-clear-correct]')) {
      state.mcqCorrectQuestionIds = []
      prepareMcqPool()
      render()
      return
    }

    if (button?.matches('[data-mcq-retry-wrong]')) {
      startMcqQuizRound({
        useWrongOnly: true,
      })
      render()
      return
    }

    if (button?.matches('[data-mcq-retry]') || button?.matches('[data-retry-mcq]')) {
      state.resultNotice = null
      const wrongSnapshot = [...state.mcqWrongQuestions]

      prepareMcqPool()
      if (!state.mcqPoolQuestions.length) {
        state.mcqSessionPhase = 'setup'
        render()
        return
      }

      startMcqQuizRound({
        appendWrongQuestions: true,
        wrongQuestions: wrongSnapshot,
      })
      render()
      return
    }

    if (button?.matches('[data-open-mcq-review]')) {
      state.resultNotice = null
      state.mcqReviewOpen = true
      render()
      return
    }

    if (button?.matches('[data-close-mcq-review]')) {
      state.mcqReviewOpen = false
      render()
      return
    }

    if (button?.matches('[data-check-result]')) {
      const type = button.dataset.checkResult
      if (!type) return
      if (type === 'mcq' && !isMcqRoundComplete()) {
        openResultNotice('mcq')
        return
      }

      if (type === 'mcq' && state.mcqSessionPhase === 'playing') {
        finishMcqSession()
      }

      openResultNotice(type)
      return
    }

    const closeTarget = target.closest('[data-close-result]')
    if (closeTarget) {
      if (
        closeTarget.classList.contains('result-overlay')
        && event.target !== closeTarget
      ) {
        return
      }
      state.resultNotice = null
      render()
    }
  })
}

function parseQuestionPayload(formData) {
  return {
    type: 'mcq',
    mode: 'general',
    question: formData.get('question').trim(),
    answer: formData.get('answer').trim(),
  }
}

function attachSourceEvents() {
  const vocabForm = document.querySelector('#vocab-form')
  if (vocabForm) {
    vocabForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const formData = new FormData(vocabForm)

      withRefresh(
        async () => {
          await createVocabulary({
            word: formData.get('word').trim(),
            definition: formData.get('definition').trim(),
            example: (formData.get('example') || '').trim(),
          })
          vocabForm.reset()
        },
        'Đã thêm từ vựng vào cơ sở dữ liệu SQLite.',
      )
    })
  }

  document.querySelectorAll('[data-delete-vocab]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.deleteVocab)
      if (!id) return
      withRefresh(
        async () => {
          await deleteVocabulary(id)
        },
        'Đã xóa từ vựng.',
      )
    })
  })

  document.querySelectorAll('[data-edit-vocab]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.editVocab)
      const item = state.database.vocabulary.find((entry) => entry.id === id)
      if (!item) return

      const word = window.prompt('Từ', item.word)
      if (word === null) return
      const definition = window.prompt('Định nghĩa', item.definition)
      if (definition === null) return
      const example = window.prompt('Ví dụ', item.example || '')
      if (example === null) return

      withRefresh(
        async () => {
          await updateVocabulary(id, {
            word: word.trim(),
            definition: definition.trim(),
            example: example.trim(),
          })
        },
        'Đã cập nhật từ vựng.',
      )
    })
  })

  const matchingForm = document.querySelector('#matching-form')
  if (matchingForm) {
    matchingForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const formData = new FormData(matchingForm)

      withRefresh(
        async () => {
          await createQuestion({
            type: 'matching',
            word: String(formData.get('word') || '').trim(),
            meaning: String(formData.get('meaning') || '').trim(),
          })
          matchingForm.reset()
        },
        'Đã thêm từ nối vào cơ sở dữ liệu.',
      )
    })
  }

  document.querySelectorAll('[data-delete-source-matching]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.deleteSourceMatching)
      if (!id) return

      withRefresh(
        async () => {
          await deleteQuestion('matching', id)
        },
        'Đã xóa từ nối.',
      )
    })
  })

  document.querySelectorAll('[data-edit-source-matching]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.editSourceMatching)
      if (!id) return

      const item = (state.database.questions.matching || []).find((entry) => entry.id === id)
      if (!item) return

      const word = window.prompt('Từ cột A', item.word)
      if (word === null) return
      const meaning = window.prompt('Từ cột B', item.meaning)
      if (meaning === null) return

      withRefresh(
        async () => {
          await updateQuestion('matching', id, {
            word: word.trim(),
            meaning: meaning.trim(),
          })
        },
        'Đã cập nhật từ nối.',
      )
    })
  })

  const questionForm = document.querySelector('#question-form')
  if (questionForm) {
    questionForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const formData = new FormData(questionForm)
      const payload = parseQuestionPayload(formData)

      withRefresh(
        async () => {
          await createQuestion(payload)
          questionForm.reset()
        },
        'Đã lưu câu hỏi vào cơ sở dữ liệu.',
      )
    })
  }

  const sharedListQuestionForm = document.querySelector('#shared-list-question-form')
  if (sharedListQuestionForm) {
    sharedListQuestionForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const formData = new FormData(sharedListQuestionForm)
      const targetType = String(formData.get('targetType') || 'listing').trim()
      const prompt = String(formData.get('prompt') || '').trim()
      const hint = String(formData.get('hint') || '').trim()
      const answers = parseWritingSampleLines(formData.get('answersText'))

      if (!answers.length) {
        state.sourceMessage = 'Bạn cần nhập ít nhất 1 dòng đáp án mẫu cho câu hỏi liệt kê dùng chung.'
        state.sourceMessageType = 'error'
        render()
        return
      }

      withRefresh(
        async () => {
          if (targetType === 'writing') {
            await createQuestion({
              type: 'writing',
              word: prompt,
              hint,
              keywords: answers,
            })
          } else {
            await createQuestion({
              type: 'listing',
              prompt,
              hint,
              answers,
            })
          }
          sharedListQuestionForm.reset()
        },
        'Đã lưu câu hỏi liệt kê dùng chung.',
      )
    })
  }

  document.querySelectorAll('[data-delete-question-answer]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.deleteQuestionAnswer)
      if (!id) return

      withRefresh(
        async () => {
          await deleteQuestion('mcq', id)
        },
        'Đã xóa câu hỏi/câu trả lời.',
      )
    })
  })

  document.querySelectorAll('[data-edit-question-answer]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.editQuestionAnswer)
      if (!id) return

      const item = (state.database.questions.mcq || []).find((entry) => entry.id === id)
      if (!item) return

      const question = window.prompt('Câu hỏi', item.question)
      if (question === null) return
      const answer = window.prompt('Đáp án đúng', item.answer)
      if (answer === null) return

      withRefresh(
        async () => {
          await updateQuestion('mcq', id, {
            mode: 'general',
            question: question.trim(),
            answer: answer.trim(),
          })
        },
        'Đã cập nhật câu hỏi/câu trả lời.',
      )
    })
  })

  document.querySelectorAll('[data-delete-shared-list-question]').forEach((button) => {
    button.addEventListener('click', () => {
      const token = String(button.dataset.deleteSharedListQuestion || '')
      const [questionType, rawId] = token.split(':')
      const id = Number(rawId)
      if (!id) return

      withRefresh(
        async () => {
          await deleteQuestion(questionType === 'writing' ? 'writing' : 'listing', id)
        },
        'Đã xóa câu hỏi liệt kê dùng chung.',
      )
    })
  })

  document.querySelectorAll('[data-edit-shared-list-question]').forEach((button) => {
    button.addEventListener('click', () => {
      const token = String(button.dataset.editSharedListQuestion || '')
      const [questionType, rawId] = token.split(':')
      const id = Number(rawId)
      if (!id) return

      const sourceList = questionType === 'writing'
        ? (state.database.questions.writing || [])
        : (state.database.questions.listing || [])
      const item = sourceList.find((entry) => entry.id === id)
      if (!item) return

      const currentPrompt = questionType === 'writing' ? item.word : item.prompt
      const currentAnswers = questionType === 'writing' ? item.keywords : item.answers

      const prompt = window.prompt('Nội dung câu hỏi / từ cần định nghĩa', currentPrompt)
      if (prompt === null) return
      const hint = window.prompt('Gợi ý', item.hint || '')
      if (hint === null) return
      const answersText = window.prompt(
        'Đáp án mẫu theo dòng (mỗi dòng 1 đáp án)',
        (currentAnswers || []).join('\n'),
      )
      if (answersText === null) return

      const answers = parseWritingSampleLines(answersText)
      if (!answers.length) {
        state.sourceMessage = 'Bạn cần nhập ít nhất 1 dòng đáp án mẫu cho câu hỏi liệt kê dùng chung.'
        state.sourceMessageType = 'error'
        render()
        return
      }

      withRefresh(
        async () => {
          if (questionType === 'writing') {
            await updateQuestion('writing', id, {
              word: prompt.trim(),
              hint: hint.trim(),
              keywords: answers,
            })
          } else {
            await updateQuestion('listing', id, {
              prompt: prompt.trim(),
              hint: hint.trim(),
              answers,
            })
          }
        },
        'Đã cập nhật câu hỏi liệt kê dùng chung.',
      )
    })
  })
}

function attachEvents() {
  attachNavEvents()
  attachExerciseEvents()
  attachSourceEvents()
}

function render() {
  state.route = getRoute()
  if (state.loading) {
    app.innerHTML = '<main class="shell"><section class="content"><p>Đang tải dữ liệu...</p></section></main>'
    return
  }
  if (state.serverError) {
    app.innerHTML = `<main class="shell"><section class="content"><p>Không truy vấn được dữ liệu: ${escapeHtml(state.serverError)}</p></section></main>`
    return
  }
  app.innerHTML = renderCurrentPage()
  attachEvents()
}

window.addEventListener('hashchange', async () => {
  state.sourceMessage = ''
  state.resultNotice = null
  await loadDataForCurrentRoute()
})

async function bootstrap() {
  if (!window.location.hash) {
    setRoute('/home')
    state.loading = false
    render()
    return
  }

  if (state.route === '/home') {
    state.loading = false
    render()
    return
  }

  await loadDataForCurrentRoute()
}

bootstrap()
