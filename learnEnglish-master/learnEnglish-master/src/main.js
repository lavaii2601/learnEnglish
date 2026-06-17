import './style.css'
import {
  createQuestion,
  createVocabulary,
  deleteQuestion,
  deleteVocabulary,
  fetchDatabase,
  updateQuestion,
  updateVocabulary,
  updateVocabularyProgress,
} from './api'

const app = document.querySelector('#app')
const SIDEBAR_OPEN_STORAGE_KEY = 'english_lab_sidebar_open'
const DATABASE_CACHE_TTL_MS = 30_000
const PERSISTENT_DATABASE_CACHE_TTL_MS = 10 * 60_000
const DATABASE_CACHE_STORAGE_KEY = 'english_lab_database_cache_v2'
const WORD_TYPE_OPTIONS = [
  { value: 'noun', label: 'Danh từ' },
  { value: 'verb', label: 'Động từ' },
  { value: 'adjective', label: 'Tính từ' },
  { value: 'other', label: 'Khác' },
]
const WORD_TYPE_LABELS = Object.fromEntries(WORD_TYPE_OPTIONS.map((option) => [option.value, option.label]))
const MASTERED_THRESHOLD = 2
const ENCOURAGEMENT_IMAGES = Array.from({ length: 15 }, (_, index) => `/picture/${index + 1}.jpg`)
const ENCOURAGEMENT_TEXTS = [
  'Bạn làm rất tốt, tiếp tục phát huy nhé!',
  'Tuyệt vời, mỗi lần luyện là một lần tiến bộ.',
  'Cố lên, bạn đang đi đúng hướng rồi.',
  'Rất ổn, giữ nhịp học đều là thắng lớn.',
  'Bạn đang tiến bộ từng ngày, quá tuyệt!',
]

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
    questions: { mcq: [], matching: [], fillBlank: [], writing: [], listing: [], arrange: [] },
  },
  mcqAnswers: [],
  matchingQuestionCount: 5,
  matchingSessionIds: [],
  matchingRightColumnIds: [],
  matchingPairs: {},
  matchingSelectedLeftId: null,
  matchingChecked: false,
  matchingShowAnswer: false,
  matchingSessionPhase: 'setup',
  blankAnswers: [],
  fillQuestionCount: 5,
  fillSessionIndexes: [],
  fillSessionPhase: 'setup',
  fillCurrentIndex: 0,
  fillCheckedMap: [],
  fillFeedbackMap: [],
  writingAnswers: [],
  writingQuestionCount: 5,
  writingSessionIndexes: [],
  writingSessionPhase: 'setup',
  writingCurrentIndex: 0,
  writingCheckedMap: [],
  writingFeedbackMap: [],
  listingAnswers: [],
  listingQuestionCount: 5,
  listingSessionIndexes: [],
  listingSessionPhase: 'setup',
  listingCurrentIndex: 0,
  listingCheckedMap: [],
  listingShowAnswerMap: [],
  slideBoardOpen: false,
  sidebarOpen: loadSidebarOpenState(),
  sourceGroupOpen: false,
  resultNotice: null,
  encouragementImageUrl: '',
  encouragementText: '',
  lastEncouragementIndex: -1,
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
  mcqShowAnswerMap: [],
  mcqNextPromptOpen: false,
  mcqReviewOpen: false,
  mcqWrongQuestions: [],
  editDialog: null,
  databaseCache: {},
  listingPreparedDirty: true,
  listingPreparedCacheItems: [],
  writingScoreDirty: true,
  writingScoreCache: [],
  listingScoreDirty: true,
  listingScoreCache: [],
  arrangeQuestionCount: 5,
  arrangeSessionIndexes: [],
  arrangeSessionPhase: 'setup',
  arrangeCurrentIndex: 0,
  arrangeCheckedMap: [],
  arrangeShowAnswerMap: [],
  arrangeTypedAnswers: [],
  arrangeFeedbackMap: [],
  arrangeWordBanks: [],
  arrangeSelectedTokenIndexes: [],
}

let renderScheduled = false
let exerciseEventsBound = false
let matchingLinesRenderScheduled = false
let lastRenderedMarkup = ''
let routeLoadToken = 0
const databaseRequestMap = new Map()

function isSourceRoute(route) {
  return route.startsWith('/source/')
}

function cloneDatabasePayload(payload) {
  return payload
}

function getDatabaseCacheKey() {
  if (state.route === '/exercise/mcq') {
    return `mcq:${state.mcqSourceMode}`
  }
  return 'default'
}

function readPersistentDatabaseCacheStore() {
  try {
    const raw = window.localStorage.getItem(DATABASE_CACHE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePersistentDatabaseCacheStore(store) {
  try {
    window.localStorage.setItem(DATABASE_CACHE_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Ignore quota and serialization failures.
  }
}

function getPersistentDatabaseEntry(key = getDatabaseCacheKey()) {
  const store = readPersistentDatabaseCacheStore()
  const cached = store[key]
  if (!cached) return null
  if (Date.now() - cached.timestamp > PERSISTENT_DATABASE_CACHE_TTL_MS) {
    delete store[key]
    writePersistentDatabaseCacheStore(store)
    return null
  }
  return cached
}

function getCachedDatabaseEntry() {
  const key = getDatabaseCacheKey()
  const cached = state.databaseCache[key]
  if (cached) {
    if (Date.now() - cached.timestamp > DATABASE_CACHE_TTL_MS) {
      delete state.databaseCache[key]
    } else {
      return cached
    }
  }

  const persistentEntry = getPersistentDatabaseEntry(key)
  if (!persistentEntry) return null
  // persistentEntry.data was just JSON.parse'd from storage, so it's already a fresh object - no clone needed.
  state.databaseCache[key] = {
    timestamp: Date.now(),
    data: persistentEntry.data,
  }
  return state.databaseCache[key]
}

function saveDatabaseCache(payload, key = getDatabaseCacheKey()) {
  const timestamp = Date.now()
  // payload comes fresh from the API response and is never mutated in place,
  // so the in-memory and persistent caches can safely share the same object;
  // JSON.stringify below serializes it for storage without needing a pre-clone.
  state.databaseCache[key] = { timestamp, data: payload }

  const store = readPersistentDatabaseCacheStore()
  store[key] = { timestamp, data: payload }
  writePersistentDatabaseCacheStore(store)
}

function clearDatabaseCache() {
  state.databaseCache = {}
  try {
    window.localStorage.removeItem(DATABASE_CACHE_STORAGE_KEY)
  } catch {
    // Ignore storage deletion failures.
  }
}

function normalizeText(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeEntityId(rawId) {
  const id = String(rawId || '').trim()
  return id || null
}

function idsEqual(left, right) {
  return normalizeEntityId(left) === normalizeEntityId(right)
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

function normalizeArrangeSentence(text) {
  return String(text || '').trim().replace(/\s+/g, ' ')
}

function getShuffledArrangeWords(sentence) {
  const words = normalizeArrangeSentence(sentence)
    .split(' ')
    .map((word) => word.trim())
    .filter(Boolean)

  if (words.length <= 1) return words
  return getShuffledItems(words)
}

function buildSessionIndexes(totalQuestions, selectedCount, maxCount) {
  const cappedTotal = Math.max(0, Number(totalQuestions) || 0)
  if (!cappedTotal) return []

  const maxAllowed = Math.min(maxCount, cappedTotal)
  const count = Math.min(maxAllowed, Math.max(1, selectedCount || 1))
  return getRandomIndexes(cappedTotal, count)
}

function clampQuestionCount(value, totalQuestions) {
  const total = Math.max(0, Number(totalQuestions) || 0)
  if (!total) return 1
  return Math.min(total, Math.max(1, Number(value) || 1))
}

function buildFillSessionIndexes(totalQuestions) {
  return buildSessionIndexes(totalQuestions, state.fillQuestionCount, totalQuestions)
}

function startFillSession(totalQuestions = (state.database.questions.fillBlank || []).length) {
  const total = Math.max(0, Number(totalQuestions) || 0)
  state.fillSessionIndexes = buildFillSessionIndexes(total)
  state.fillCurrentIndex = 0
  state.fillCheckedMap = Array(total).fill(false)
  state.fillFeedbackMap = Array(total).fill('')
  state.blankAnswers = Array(total).fill('')
  state.fillSessionPhase = state.fillSessionIndexes.length ? 'playing' : 'setup'
}

function gradeFillSession() {
  state.fillSessionIndexes.forEach((index) => {
    const item = state.database.questions.fillBlank[index]
    const isCorrect = normalizeText(state.blankAnswers[index] || '') === normalizeText(item?.answer || '')
    state.fillCheckedMap[index] = isCorrect
    state.fillFeedbackMap[index] = isCorrect
      ? 'Chính xác!'
      : 'Chưa đúng. Đáp án đúng đã được hiển thị bên dưới.'
  })
  state.fillSessionPhase = 'completed'
}

function buildWritingSessionIndexes(totalQuestions) {
  return buildSessionIndexes(totalQuestions, state.writingQuestionCount, totalQuestions)
}

function startWritingSession(totalQuestions = (state.database.questions.mcq || []).length) {
  const total = Math.max(0, Number(totalQuestions) || 0)
  state.writingSessionIndexes = buildWritingSessionIndexes(total)
  state.writingCurrentIndex = 0
  state.writingCheckedMap = Array(total).fill(false)
  state.writingFeedbackMap = Array(total).fill('')
  state.writingAnswers = Array(total).fill('')
  state.writingScoreDirty = true
  state.writingSessionPhase = state.writingSessionIndexes.length ? 'playing' : 'setup'
}

function gradeWritingSession() {
  state.writingSessionIndexes.forEach((index) => {
    const item = state.database.questions.mcq[index]
    const isCorrect = normalizeText(state.writingAnswers[index] || '') === normalizeText(item?.answer || '')
    state.writingCheckedMap[index] = isCorrect
    state.writingFeedbackMap[index] = isCorrect
      ? 'Chính xác!'
      : 'Chưa đúng. Đáp án đúng đã được hiển thị bên dưới.'
  })
  state.writingScoreDirty = true
  state.writingSessionPhase = 'completed'
}

function buildArrangeSessionIndexes(totalQuestions) {
  return buildSessionIndexes(totalQuestions, state.arrangeQuestionCount, totalQuestions)
}

function resetArrangeSession(totalQuestions) {
  const total = Math.max(0, Number(totalQuestions) || 0)
  state.arrangeSessionIndexes = buildArrangeSessionIndexes(total)
  state.arrangeCurrentIndex = 0
  state.arrangeCheckedMap = Array(total).fill(false)
  state.arrangeShowAnswerMap = Array(total).fill(false)
  state.arrangeFeedbackMap = Array(total).fill('')
  state.arrangeTypedAnswers = Array(total).fill('')
  state.arrangeWordBanks = Array.from({ length: total }, (_, index) => (
    getShuffledArrangeWords(state.database.questions.arrange?.[index]?.answer)
  ))
  state.arrangeSelectedTokenIndexes = Array.from({ length: total }, () => [])
  state.arrangeSessionPhase = state.arrangeSessionIndexes.length ? 'playing' : 'setup'
}

function gradeArrangeSession() {
  state.arrangeSessionIndexes.forEach((index) => {
    const item = (state.database.questions.arrange || [])[index]
    const userSentence = normalizeArrangeSentence(state.arrangeTypedAnswers[index])
    const expectedSentence = normalizeArrangeSentence(item?.answer)
    const isCorrect = Boolean(userSentence && userSentence === expectedSentence)
    state.arrangeCheckedMap[index] = isCorrect
    state.arrangeFeedbackMap[index] = isCorrect
      ? 'Chính xác! Bạn đã nhập đúng hoàn toàn theo ký tự.'
      : 'Chưa đúng. Đáp án đúng đã được hiển thị bên dưới.'
    state.arrangeShowAnswerMap[index] = !isCorrect
  })
  state.arrangeSessionPhase = 'completed'
}

function scoreArrange() {
  return state.arrangeSessionIndexes
    .filter((index) => state.arrangeCheckedMap[index])
    .length
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
        normalized: normalizeText(line),
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

function getRandomIndexes(total, count) {
  const cappedTotal = Math.max(0, Number(total) || 0)
  const cappedCount = Math.min(cappedTotal, Math.max(0, Number(count) || 0))
  const indexSwaps = new Map()
  const picked = []

  for (let index = 0; index < cappedCount; index += 1) {
    const swapIndex = index + Math.floor(Math.random() * (cappedTotal - index))
    const pickedIndex = indexSwaps.get(swapIndex) ?? swapIndex
    const currentIndex = indexSwaps.get(index) ?? index
    indexSwaps.set(swapIndex, currentIndex)
    picked.push(pickedIndex)
  }

  return picked
}

function getRandomItems(items, count) {
  const list = Array.isArray(items) ? items : []
  const indexes = getRandomIndexes(list.length, count)
  return indexes.map((index) => list[index])
}

function getUniqueListingQuestionIndexes(totalQuestions = (state.database.questions.listing || []).length) {
  const items = state.database.questions.listing || []
  const uniqueIndexes = []
  const seenKeys = new Set()

  items.forEach((item, index) => {
    const key = normalizeText(item?.prompt || '')
    const fallbackKey = `__index_${index}`
    const questionKey = key || fallbackKey
    if (seenKeys.has(questionKey)) return
    seenKeys.add(questionKey)
    uniqueIndexes.push(index)
  })

  if (uniqueIndexes.length) return uniqueIndexes
  const fallbackCount = Math.max(0, Number(totalQuestions) || 0)
  return Array.from({ length: fallbackCount }, (_, index) => index)
}

function buildListingSessionIndexes(totalQuestions) {
  const uniqueIndexes = getUniqueListingQuestionIndexes(totalQuestions)
  const selectableCount = uniqueIndexes.length
  const selectedCount = clampQuestionCount(state.listingQuestionCount, selectableCount)
  return getRandomItems(uniqueIndexes, selectedCount)
}

function resetListingSession(totalQuestions) {
  state.listingSessionIndexes = buildListingSessionIndexes(totalQuestions)
  // listingCurrentIndex stores the position inside listingSessionIndexes, not the question index.
  state.listingCurrentIndex = 0
  state.listingCheckedMap = Array(totalQuestions).fill(false)
  state.listingShowAnswerMap = Array(totalQuestions).fill(false)
  state.listingAnswers = Array(totalQuestions).fill('')
  state.listingScoreDirty = true
  state.listingSessionPhase = state.listingSessionIndexes.length ? 'playing' : 'setup'
}

function gradeListingSession() {
  const sessionIndexSet = new Set(state.listingSessionIndexes)
  state.listingSessionIndexes.forEach((index) => {
    state.listingCheckedMap[index] = true
  })
  state.listingShowAnswerMap = state.listingShowAnswerMap.map((value, index) => (
    sessionIndexSet.has(index) ? true : value
  ))
  state.listingScoreDirty = true
  state.listingSessionPhase = 'completed'
}

function resetMatchingSession(totalQuestions = (state.database.questions.matching || []).length) {
  const cappedTotal = Math.max(0, Number(totalQuestions) || 0)
  if (!cappedTotal) {
    state.matchingSessionIds = []
    state.matchingRightColumnIds = []
    state.matchingPairs = {}
    state.matchingSelectedLeftId = null
    state.matchingChecked = false
    state.matchingShowAnswer = false
    state.matchingSessionPhase = 'setup'
    return
  }

  const selectedCount = clampQuestionCount(state.matchingQuestionCount, cappedTotal)
  const selectedIds = getRandomItems(state.database.questions.matching, selectedCount)
    .map((item) => item.id)

  state.matchingSessionIds = selectedIds
  state.matchingRightColumnIds = getShuffledItems(selectedIds)
  state.matchingPairs = {}
  state.matchingSelectedLeftId = selectedIds[0] || null
  state.matchingChecked = false
  state.matchingShowAnswer = false
  state.matchingSessionPhase = 'playing'
}

function clearMatchingSession() {
  state.matchingSessionIds = []
  state.matchingRightColumnIds = []
  state.matchingPairs = {}
  state.matchingSelectedLeftId = null
  state.matchingChecked = false
  state.matchingShowAnswer = false
  state.matchingSessionPhase = 'setup'
}

function startMatchingSession() {
  resetMatchingSession((state.database.questions.matching || []).length)
  if (!state.matchingSessionIds.length) {
    state.matchingSessionPhase = 'setup'
    return
  }
  state.matchingSessionPhase = 'playing'
}

function invalidateScoreCaches() {
  state.writingScoreDirty = true
  state.listingScoreDirty = true
}

function pickMixedQuizItems(pool, maxCount) {
  if (!Array.isArray(pool) || maxCount <= 0) return []

  const vocabularyItems = pool.filter((item) => item?.source === 'vocabulary')
  const questionItems = pool.filter((item) => item?.source === 'question')
  const picked = []

  // Guarantee at least one question from each source when both sources exist.
  if (vocabularyItems.length && questionItems.length && maxCount >= 2) {
    picked.push(getRandomItems(questionItems, 1)[0])
    picked.push(getRandomItems(vocabularyItems, 1)[0])
  }

  const pickedKeySet = new Set(picked.map((item) => getMcqItemKey(item)))
  const remainingPool = pool.filter((item) => !pickedKeySet.has(getMcqItemKey(item)))
  picked.push(...getRandomItems(remainingPool, maxCount - picked.length))

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
    : getRandomItems(pool, maxCount)
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
  state.mcqShowAnswerMap = Array(quizItems.length).fill(false)
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
    arrange = [],
  } = state.database.questions
  prepareMcqPool()
  state.mcqQuizQuestions = []
  state.mcqAnswers = []
  state.mcqCurrentIndex = 0
  state.mcqShowAnswerMap = []
  state.mcqNextPromptOpen = false
  state.mcqReviewOpen = false
  state.mcqSessionPhase = 'setup'
  state.mcqWrongQuestions = []
  resetMatchingSession(matching.length)
  clearMatchingSession()
  state.blankAnswers = Array(fillBlank.length).fill('')
  state.fillSessionIndexes = []
  state.fillSessionPhase = 'setup'
  state.fillCurrentIndex = 0
  state.fillCheckedMap = Array(fillBlank.length).fill(false)
  state.fillFeedbackMap = Array(fillBlank.length).fill('')
  state.writingAnswers = Array(state.database.questions.mcq.length).fill('')
  state.writingSessionIndexes = []
  state.writingSessionPhase = 'setup'
  state.writingCurrentIndex = 0
  state.writingCheckedMap = Array(state.database.questions.mcq.length).fill(false)
  state.writingFeedbackMap = Array(state.database.questions.mcq.length).fill('')
  state.listingAnswers = Array(listing.length).fill('')
  state.listingSessionIndexes = []
  state.listingSessionPhase = 'setup'
  state.listingCurrentIndex = 0
  state.listingCheckedMap = Array(listing.length).fill(false)
  state.listingShowAnswerMap = Array(listing.length).fill(false)
  state.listingPreparedDirty = true
  state.arrangeSessionIndexes = []
  state.arrangeSessionPhase = 'setup'
  state.arrangeCurrentIndex = 0
  state.arrangeCheckedMap = Array(arrange.length).fill(false)
  state.arrangeShowAnswerMap = Array(arrange.length).fill(false)
  state.arrangeFeedbackMap = Array(arrange.length).fill('')
  state.arrangeTypedAnswers = Array(arrange.length).fill('')
  state.arrangeWordBanks = Array.from({ length: arrange.length }, (_, index) => (
    getShuffledArrangeWords(state.database.questions.arrange?.[index]?.answer)
  ))
  state.arrangeSelectedTokenIndexes = Array.from({ length: arrange.length }, () => [])
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

function renderMatchingLines() {
  const board = app.querySelector('.matching-board')
  const svg = app.querySelector('[data-matching-lines]')
  if (!board || !svg || state.route !== '/exercise/matching' || state.matchingSessionPhase !== 'playing') {
    if (svg) svg.innerHTML = ''
    return
  }

  const boardRect = board.getBoundingClientRect()
  if (!boardRect.width || !boardRect.height) {
    svg.innerHTML = ''
    return
  }

  svg.setAttribute('viewBox', `0 0 ${boardRect.width} ${boardRect.height}`)
  svg.setAttribute('width', String(boardRect.width))
  svg.setAttribute('height', String(boardRect.height))

  const lineMarkup = Object.entries(state.matchingPairs)
    .map(([leftId, rightId]) => {
      const leftElement = app.querySelector(`[data-match-left="${leftId}"]`)
      const rightElement = app.querySelector(`[data-match-right="${rightId}"]`)
      if (!leftElement || !rightElement) return ''

      const leftRect = leftElement.getBoundingClientRect()
      const rightRect = rightElement.getBoundingClientRect()
      const x1 = leftRect.right - boardRect.left
      const y1 = leftRect.top + (leftRect.height / 2) - boardRect.top
      const x2 = rightRect.left - boardRect.left
      const y2 = rightRect.top + (rightRect.height / 2) - boardRect.top
      const controlDistance = Math.max(40, Math.abs(x2 - x1) * 0.35)

      const isCorrect = state.matchingChecked && Number(leftId) === Number(rightId)
      const isWrong = state.matchingChecked && Number(leftId) !== Number(rightId)
      const stateClass = isCorrect
        ? 'correct'
        : isWrong
          ? 'wrong'
          : 'normal'

      return `<path class="matching-line ${stateClass}" d="M ${x1} ${y1} C ${x1 + controlDistance} ${y1}, ${x2 - controlDistance} ${y2}, ${x2} ${y2}" />`
    })
    .filter(Boolean)
    .join('')

  svg.innerHTML = lineMarkup
}

function scheduleMatchingLinesRender() {
  if (matchingLinesRenderScheduled) return
  matchingLinesRenderScheduled = true
  window.requestAnimationFrame(() => {
    matchingLinesRenderScheduled = false
    renderMatchingLines()
  })
}

function pickEncouragement() {
  if (!ENCOURAGEMENT_IMAGES.length) {
    state.encouragementImageUrl = ''
    state.encouragementText = ''
    return
  }

  let nextIndex = Math.floor(Math.random() * ENCOURAGEMENT_IMAGES.length)
  if (ENCOURAGEMENT_IMAGES.length > 1 && nextIndex === state.lastEncouragementIndex) {
    nextIndex = (nextIndex + 1) % ENCOURAGEMENT_IMAGES.length
  }

  state.lastEncouragementIndex = nextIndex
  state.encouragementImageUrl = ENCOURAGEMENT_IMAGES[nextIndex]
  state.encouragementText = ENCOURAGEMENT_TEXTS[Math.floor(Math.random() * ENCOURAGEMENT_TEXTS.length)]
}

function closeEditDialog() {
  state.editDialog = null
  render()
}

function openEditDialog(dialog) {
  state.editDialog = dialog
  render()
}

function getEditDialogTitle(dialog) {
  switch (dialog?.kind) {
    case 'vocab':
      return 'Sửa từ vựng'
    case 'matching':
      return 'Sửa từ nối'
    case 'mcq':
      return 'Sửa câu hỏi trắc nghiệm'
    case 'fillBlank':
      return 'Sửa câu điền chỗ trống'
    case 'writing':
      return 'Sửa đề viết định nghĩa'
    case 'listing':
      return 'Sửa câu hỏi liệt kê'
    case 'arrange':
      return 'Sửa câu hỏi sắp xếp'
    default:
      return 'Sửa dữ liệu'
  }
}

function getEditDialogActionLabel(dialog) {
  switch (dialog?.kind) {
    case 'vocab':
      return 'Lưu từ vựng'
    case 'matching':
      return 'Lưu từ nối'
    case 'mcq':
      return 'Lưu câu hỏi'
    case 'fillBlank':
      return 'Lưu câu điền chỗ trống'
    case 'writing':
      return 'Lưu đề viết'
    case 'listing':
      return 'Lưu câu liệt kê'
    case 'arrange':
      return 'Lưu câu sắp xếp'
    default:
      return 'Lưu thay đổi'
  }
}

function renderEditDialog() {
  const dialog = state.editDialog
  if (!dialog) return ''

  const title = getEditDialogTitle(dialog)
  const actionLabel = getEditDialogActionLabel(dialog)

  let bodyMarkup = ''
  if (dialog.kind === 'vocab') {
    bodyMarkup = `
      <label>Từ<input name="word" required value="${escapeHtml(dialog.word || '')}" /></label>
      <label>Loại từ
        <select name="wordType">
          ${WORD_TYPE_OPTIONS.map((option) => `<option value="${option.value}" ${dialog.wordType === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}
        </select>
      </label>
      <label>Định nghĩa<textarea name="definition" required rows="4">${escapeHtml(dialog.definition || '')}</textarea></label>
      <label>Ví dụ<textarea name="example" rows="3">${escapeHtml(dialog.example || '')}</textarea></label>
    `
  }

  if (dialog.kind === 'matching') {
    bodyMarkup = `
      <label>Từ cột A<input name="word" required value="${escapeHtml(dialog.word || '')}" /></label>
      <label>Từ cột B<textarea name="meaning" required rows="4">${escapeHtml(dialog.meaning || '')}</textarea></label>
    `
  }

  if (dialog.kind === 'mcq') {
    bodyMarkup = `
      <label>Câu hỏi<textarea name="question" required rows="4">${escapeHtml(dialog.question || '')}</textarea></label>
      <label>Đáp án đúng<textarea name="answer" required rows="3">${escapeHtml(dialog.answer || '')}</textarea></label>
    `
  }

  if (dialog.kind === 'fillBlank') {
    bodyMarkup = `
      <label>Câu có chỗ trống<textarea name="sentence" required rows="4">${escapeHtml(dialog.sentence || '')}</textarea></label>
      <label>Đáp án đúng<textarea name="answer" required rows="3">${escapeHtml(dialog.answer || '')}</textarea></label>
    `
  }

  if (dialog.kind === 'writing') {
    bodyMarkup = `
      <label>Từ cần định nghĩa<input name="word" required value="${escapeHtml(dialog.word || '')}" /></label>
      <label>Gợi ý<textarea name="hint" rows="3">${escapeHtml(dialog.hint || '')}</textarea></label>
      <label>Đáp án mẫu theo dòng<textarea name="answersText" required rows="5">${escapeHtml((dialog.keywords || []).join('\n'))}</textarea></label>
    `
  }

  if (dialog.kind === 'listing') {
    bodyMarkup = `
      <label>Nội dung câu hỏi<textarea name="prompt" required rows="4">${escapeHtml(dialog.prompt || '')}</textarea></label>
      <label>Gợi ý<textarea name="hint" rows="3">${escapeHtml(dialog.hint || '')}</textarea></label>
      <label>Đáp án mẫu theo dòng<textarea name="answersText" required rows="5">${escapeHtml((dialog.answers || []).join('\n'))}</textarea></label>
    `
  }

  if (dialog.kind === 'arrange') {
    bodyMarkup = `
      <label>Nội dung câu hỏi<textarea name="prompt" required rows="4">${escapeHtml(dialog.prompt || '')}</textarea></label>
      <label>Gợi ý<textarea name="hint" rows="3">${escapeHtml(dialog.hint || '')}</textarea></label>
      <label>Câu đúng cần sắp xếp<textarea name="answer" required rows="3">${escapeHtml(dialog.answer || '')}</textarea></label>
    `
  }

  return `
    <div class="edit-overlay" data-close-edit-dialog="true">
      <section class="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-dialog-title">
        <div class="edit-dialog-header">
          <div>
            <h3 id="edit-dialog-title">${escapeHtml(title)}</h3>
            <p class="muted">Chỉnh sửa dữ liệu trực tiếp trong popup, sau đó lưu để cập nhật ngay.</p>
          </div>
          <button type="button" class="icon-btn" aria-label="Đóng popup" data-close-edit-dialog="true">&times;</button>
        </div>
        <form data-edit-dialog-form>
          <input type="hidden" name="kind" value="${escapeHtml(dialog.kind)}" />
          <input type="hidden" name="id" value="${escapeHtml(String(dialog.id || ''))}" />
          <input type="hidden" name="questionType" value="${escapeHtml(dialog.questionType || '')}" />
          <div class="edit-form-grid">
            ${bodyMarkup}
          </div>
          <div class="edit-dialog-actions">
            <button type="button" class="small-btn" data-close-edit-dialog="true">Hủy</button>
            <button type="submit" class="action-btn">${escapeHtml(actionLabel)}</button>
          </div>
        </form>
      </section>
    </div>
  `
}

async function submitEditDialog(formData) {
  const kind = String(formData.get('kind') || '').trim()
  const id = normalizeEntityId(formData.get('id'))
  if (!kind || !id) return false

  if (kind === 'vocab') {
    const word = String(formData.get('word') || '').trim()
    const definition = String(formData.get('definition') || '').trim()
    const example = String(formData.get('example') || '').trim()
    const wordType = String(formData.get('wordType') || 'other').trim()
    if (!word || !definition) return false

    await updateVocabulary(id, { word, definition, example, wordType })
    state.editDialog = null
    return true
  }

  if (kind === 'matching') {
    const word = String(formData.get('word') || '').trim()
    const meaning = String(formData.get('meaning') || '').trim()
    if (!word || !meaning) return false

    await updateQuestion('matching', id, { word, meaning })
    state.editDialog = null
    return true
  }

  if (kind === 'mcq') {
    const question = String(formData.get('question') || '').trim()
    const answer = String(formData.get('answer') || '').trim()
    if (!question || !answer) return false

    await updateQuestion('mcq', id, {
      mode: 'general',
      question,
      answer,
    })
    state.editDialog = null
    return true
  }

  if (kind === 'fillBlank') {
    const sentence = String(formData.get('sentence') || '').trim()
    const answer = String(formData.get('answer') || '').trim()
    if (!sentence || !answer) return false

    await updateQuestion('fillBlank', id, { sentence, answer })
    state.editDialog = null
    return true
  }

  if (kind === 'writing' || kind === 'listing') {
    const questionType = String(formData.get('questionType') || kind).trim()
    const prompt = String(formData.get(kind === 'writing' ? 'word' : 'prompt') || '').trim()
    const hint = String(formData.get('hint') || '').trim()
    const answersText = String(formData.get('answersText') || '')
    const answers = parseWritingSampleLines(answersText)
    if (!prompt || !answers.length) return false

    if (questionType === 'writing') {
      await updateQuestion('writing', id, {
        word: prompt,
        hint,
        keywords: answers,
      })
    } else {
      await updateQuestion('listing', id, {
        prompt,
        hint,
        answers,
      })
    }
    state.editDialog = null
    return true
  }

  if (kind === 'arrange') {
    const prompt = String(formData.get('prompt') || '').trim()
    const hint = String(formData.get('hint') || '').trim()
    const answer = normalizeArrangeSentence(formData.get('answer'))
    if (!prompt || !answer) return false

    await updateQuestion('arrange', id, {
      prompt,
      hint,
      answer,
    })
    state.editDialog = null
    return true
  }

  return false
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
  const indexes = state.fillSessionIndexes.length
    ? state.fillSessionIndexes
    : state.database.questions.fillBlank.map((_, index) => index)
  indexes.forEach((index) => {
    const item = state.database.questions.fillBlank[index]
    if (normalizeText(state.blankAnswers[index] || '') === normalizeText(item.answer)) {
      score += 1
    }
  })
  return score
}

function scoreWriting() {
  if (!state.writingScoreDirty) return state.writingScoreCache

  const scores = state.database.questions.mcq.map((item, index) => {
    const isCorrect = normalizeText(state.writingAnswers[index] || '') === normalizeText(item.answer || '')
    return {
      hitCount: isCorrect ? 1 : 0,
      total: 1,
      percent: isCorrect ? 100 : 0,
    }
  })
  state.writingScoreCache = scores
  state.writingScoreDirty = false
  return state.writingScoreCache
}

function getWritingCorrectCount(scores = scoreWriting()) {
  const indexes = state.writingSessionIndexes.length
    ? state.writingSessionIndexes
    : scores.map((_, index) => index)
  return indexes.filter((index) => scores[index]?.percent >= 60).length
}

function scoreListing() {
  if (!state.listingScoreDirty) return state.listingScoreCache

  const scores = getListingPreparedItems().map((item, index) => {
    const userLines = parseWritingSampleLines(state.listingAnswers[index] || '')
    const totalExpectedIdeas = item.expectedEntries.length

    const usedExpectedIndexes = new Set()
    const ideaDetails = userLines.map((userLine) => {
      const userNormalized = normalizeListLine(userLine)
      const matchedExpectedIndex = item.expectedEntries.findIndex((expectedEntry, expectedIndex) => {
        if (usedExpectedIndexes.has(expectedIndex)) return false
        return linesMatch(userNormalized, expectedEntry.normalized)
      })

      const matchedExpected = matchedExpectedIndex >= 0
        ? item.expectedEntries[matchedExpectedIndex]
        : null

      if (matchedExpectedIndex >= 0) {
        usedExpectedIndexes.add(matchedExpectedIndex)
      }

      return {
        expected: matchedExpected ? matchedExpected.raw : '',
        user: userLine,
        isCorrect: Boolean(matchedExpected),
      }
    })

    const hitCount = ideaDetails.filter((item) => item.isCorrect).length
    const percent = totalExpectedIdeas
      ? Math.round((hitCount / totalExpectedIdeas) * 100)
      : 0

    return {
      hitCount,
      total: totalExpectedIdeas,
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
    .filter((item) => item.total > 0 && item.hitCount === item.total)
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
    total = state.fillSessionIndexes.length || state.database.questions.fillBlank.length
    title = 'Kết quả điền chỗ trống'
  }

  if (type === 'writing') {
    const writingScores = scoreWriting()
    correct = getWritingCorrectCount(writingScores)
    total = state.writingSessionIndexes.length || state.database.questions.mcq.length
    title = 'Kết quả viết câu trả lời'
  }

  if (type === 'listing') {
    const listingScores = scoreListing()
    correct = getListingCorrectCount(listingScores, state.listingSessionIndexes)
    total = state.listingSessionIndexes.reduce((sum, index) => sum + (listingScores[index]?.total || 0), 0)
    title = 'Kết quả bài liệt kê'
  }

  if (type === 'arrange') {
    correct = scoreArrange()
    total = state.arrangeSessionIndexes.length
    title = 'Kết quả sắp xếp câu'
  }

  state.resultNotice = {
    type,
    title,
    message: type === 'listing'
      ? `Bạn làm đúng ${correct}/${total} ý.`
      : `Bạn làm đúng ${correct}/${total} câu.`,
  }
  pickEncouragement()

  render()
}

const ROUTE_TITLE_MAP = {
  '/welcome': 'Chào mừng',
  '/home': 'Trang chủ',
  '/exercise/mcq': 'Trắc nghiệm',
  '/exercise/matching': 'Nối từ',
  '/exercise/fill': 'Điền chỗ trống',
  '/exercise/writing': 'Viết định nghĩa',
  '/exercise/listing': 'Liệt kê ý',
  '/exercise/arrange': 'Sắp xếp câu',
  '/source/vocab': 'Thêm từ vựng',
  '/source/questions': 'Thêm câu hỏi',
  '/source/matching': 'Thêm từ nối',
}

function renderLayout(content) {
  const questionAnswerCount = state.database.questions.mcq.length
  const vocabularyCount = state.database.vocabulary.length
  const uniqueVocabularyCount = new Set(
    state.database.vocabulary
      .map((item) => normalizeText(String(item.word || '')))
      .filter(Boolean),
  ).size
  const duplicateVocabularyCount = vocabularyCount - uniqueVocabularyCount
  const masteredCount = state.database.vocabulary.filter(
    (item) => (item.masteredCount || 0) >= MASTERED_THRESHOLD,
  ).length
  const mcqTotalCount = vocabularyCount + questionAnswerCount
  const matchingCount = state.database.questions.matching.length
  const fillBlankCount = state.database.questions.fillBlank.length
  const writingDataCount = state.database.questions.writing.length
  const totalQuestions =
    questionAnswerCount +
    matchingCount +
    fillBlankCount +
    writingDataCount +
    (state.database.questions.listing || []).length +
    (state.database.questions.arrange || []).length
  const listingCount = (state.database.questions.listing || []).length
  const arrangeCount = (state.database.questions.arrange || []).length

  const quickBoardMarkup = `
    <header class="slide-board-head">
      <div>
        <strong>Thông tin nguồn dữ liệu</strong>
        <p class="muted">Số lượng dữ liệu hiện có trong Supabase.</p>
      </div>
      <button type="button" class="slide-board-close" data-toggle-slide-board="true">Đóng</button>
    </header>
    <div class="slide-stat-grid">
      <article><span>Bản ghi từ vựng</span><strong>${vocabularyCount}</strong></article>
      <article><span>Từ vựng duy nhất</span><strong>${uniqueVocabularyCount}</strong></article>
      ${duplicateVocabularyCount > 0 ? `<article class="warning"><span>Bản ghi trùng từ</span><strong>${duplicateVocabularyCount}</strong></article>` : ''}
      <article><span>Tổng câu hỏi</span><strong>${totalQuestions}</strong></article>
      <article><span>Trắc nghiệm đã nhập</span><strong>${questionAnswerCount}</strong></article>
      <article><span>Trắc nghiệm từ kho từ</span><strong>${vocabularyCount}</strong></article>
      <article><span>Tổng nguồn trắc nghiệm</span><strong>${mcqTotalCount}</strong></article>
      <article><span>Nối từ</span><strong>${matchingCount}</strong></article>
      <article><span>Điền chỗ trống</span><strong>${fillBlankCount}</strong></article>
      <article><span>Viết (câu hỏi + trả lời)</span><strong>${questionAnswerCount}</strong></article>
      <article><span>Liệt kê</span><strong>${listingCount}</strong></article>
      <article><span>Sắp xếp câu</span><strong>${arrangeCount}</strong></article>
    </div>
  `

  return `
    <main class="shell app-shell ${state.sidebarOpen ? '' : 'menu-hidden'}">
      <aside class="sidebar">
        <section class="sidebar-head">
          <h1>Học tiếng Anh cùng Hồng Nga</h1>
          <p class="muted">Luyện tập và quản lý dữ liệu học tiếng Anh.</p>
        </section>

        <section class="sidebar-scroll" data-sidebar-scroll>
          <p class="group-title">Điều hướng</p>
          <button class="nav-btn ${state.route === '/home' ? 'active' : ''}" data-route="/home"><span class="nav-icon">⌂</span>Trang chủ</button>

          <p class="group-title">Bài tập</p>
          <button class="nav-btn ${state.route === '/exercise/mcq' ? 'active' : ''}" data-route="/exercise/mcq"><span class="nav-icon">☑</span>Trắc nghiệm</button>
          <button class="nav-btn ${state.route === '/exercise/matching' ? 'active' : ''}" data-route="/exercise/matching"><span class="nav-icon">↔</span>Nối từ</button>
          <button class="nav-btn ${state.route === '/exercise/fill' ? 'active' : ''}" data-route="/exercise/fill"><span class="nav-icon">▣</span>Điền chỗ trống</button>
          <button class="nav-btn ${state.route === '/exercise/writing' ? 'active' : ''}" data-route="/exercise/writing"><span class="nav-icon">／</span>Viết</button>
          <button class="nav-btn ${state.route === '/exercise/listing' ? 'active' : ''}" data-route="/exercise/listing"><span class="nav-icon">☷</span>Liệt kê</button>
          <button class="nav-btn ${state.route === '/exercise/arrange' ? 'active' : ''}" data-route="/exercise/arrange"><span class="nav-icon">☰</span>Sắp xếp câu</button>

          <p class="group-title">Nguồn dữ liệu</p>
          <button class="nav-btn ${state.route === '/source/vocab' ? 'active' : ''}" data-route="/source/vocab"><span class="nav-icon">＋</span>Thêm từ vựng</button>
          <button class="nav-btn ${state.route === '/source/questions' ? 'active' : ''}" data-route="/source/questions"><span class="nav-icon">▦</span>Thêm câu hỏi</button>
          <button class="nav-btn ${state.route === '/source/matching' ? 'active' : ''}" data-route="/source/matching"><span class="nav-icon">⊞</span>Thêm từ nối</button>
        </section>

        <section class="sidebar-tools">
          <div class="menu-scroll-controls">
            <button type="button" class="small-btn menu-scroll-btn" data-menu-scroll="up">Lên</button>
            <button type="button" class="small-btn menu-scroll-btn" data-menu-scroll="down">Xuống</button>
          </div>

          <button class="slide-trigger ${state.slideBoardOpen ? 'active' : ''}" data-toggle-slide-board="true" type="button" aria-expanded="${state.slideBoardOpen ? 'true' : 'false'}"><span class="nav-icon">▦</span>${state.slideBoardOpen ? 'Đóng bảng nhanh' : 'Mở bảng nhanh'}</button>
        </section>

      </aside>

      ${state.slideBoardOpen
        ? `
          <div class="quick-board-overlay" data-toggle-slide-board="true">
            <section
              class="quick-board-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Thông tin nguồn dữ liệu"
              data-quick-board-dialog
            >
              ${quickBoardMarkup}
            </section>
          </div>
        `
        : ''}

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
            <p class="route-pill">${ROUTE_TITLE_MAP[state.route] || 'Học tiếng Anh cùng Hồng Nga'}</p>
          </div>
          <p class="header-stats">Kho từ vựng: <strong>${vocabularyCount} từ</strong> · Đã thuộc: <strong>${masteredCount} từ</strong></p>
        </header>
        ${content}
      </section>

      ${state.resultNotice
        ? `
          <div class="result-overlay" data-close-result="true">
            <section class="result-dialog" role="dialog" aria-modal="true" aria-labelledby="result-dialog-title">
              <h3 id="result-dialog-title">${escapeHtml(state.resultNotice.title)}</h3>
              <p>${escapeHtml(state.resultNotice.message)}</p>
              ${state.encouragementImageUrl
    ? `
                  <article class="result-encouragement">
                    <img src="${escapeHtml(state.encouragementImageUrl)}" alt="Hình động viên" loading="lazy" decoding="async" onerror="this.style.display='none'" />
                    <p>${escapeHtml(state.encouragementText || 'Giữ vững phong độ học tập nhé!')}</p>
                  </article>
                `
    : ''}
              ${state.resultNotice.type === 'mcq' ? '<button type="button" class="small-btn" data-open-mcq-review>Xem lại đúng/sai</button>' : ''}
              ${state.resultNotice.type === 'mcq' ? '<button type="button" class="small-btn" data-retry-mcq>Random bộ mới</button>' : ''}
              <button type="button" class="action-btn" data-close-result="true">Đóng</button>
            </section>
          </div>
        `
        : ''}
      ${renderEditDialog()}
    </main>
  `
}

function renderLandingPage() {
  return `
    <main class="landing-shell">
      <section class="landing-card">
        <img
          class="brand-logo landing-logo"
          src="/favicon.svg"
          alt="Logo Học tiếng Anh cùng Hồng Nga"
          onerror="this.style.display='none'"
        />
        <p class="landing-eyebrow">Học tiếng Anh cùng Hồng Nga</p>
        <h1>Luyện tiếng Anh 5 cùng Hồng Nga</h1>
        <p class="landing-subtitle">Bắt đầu nhanh với bộ bài tập và trang quản lý dữ liệu học tập.</p>
        <div class="landing-actions">
          <button type="button" class="action-btn" data-route="/home">Vào trang chủ</button>
          <button type="button" class="small-btn" data-route="/exercise/mcq">Luyện tập ngay</button>
          <button type="button" class="small-btn" data-route="/source/vocab">Quản lý nguồn dữ liệu</button>
        </div>
      </section>
    </main>
  `
}

async function refreshDatabase(options = {}) {
  const { force = false } = options
  const cacheKey = getDatabaseCacheKey()

  if (!force) {
    const cached = getCachedDatabaseEntry()
    if (cached) {
      state.database = cloneDatabasePayload(cached.data)
      return
    }
  }

  const requestKey = `${cacheKey}:${force ? 'fresh' : 'cached'}`
  if (!databaseRequestMap.has(requestKey)) {
    const request = (state.route === '/exercise/mcq'
      ? fetchDatabase({
        mcqMode: state.mcqSourceMode,
        fresh: force,
      })
      : fetchDatabase({ fresh: force }))
      .finally(() => {
        databaseRequestMap.delete(requestKey)
      })

    databaseRequestMap.set(requestKey, request)
  }

  const payload = await databaseRequestMap.get(requestKey)
  if (getDatabaseCacheKey() === cacheKey) {
    state.database = payload
  }
  saveDatabaseCache(payload, cacheKey)
}

async function loadDataForCurrentRoute() {
  const loadToken = routeLoadToken + 1
  routeLoadToken = loadToken

  if (state.route === '/welcome') {
    state.loading = false
    state.serverError = ''
    render()
    void preloadDatabase()
    return
  }

  const cached = getCachedDatabaseEntry()
  const hasFreshCache = Boolean(cached)
  if (cached) {
    state.database = cloneDatabasePayload(cached.data)
    resetExerciseState()
  }

  state.loading = !hasFreshCache
  state.serverError = ''
  render()

  if (!hasFreshCache) {
    try {
      await refreshDatabase({ force: false })
      if (loadToken !== routeLoadToken) return
      resetExerciseState()
    } catch (error) {
      if (loadToken !== routeLoadToken) return
      state.serverError = error.message || 'Không truy vấn được dữ liệu từ cơ sở dữ liệu.'
    }
  }

  if (loadToken !== routeLoadToken) return
  state.loading = false
  render()
}

async function preloadDatabase() {
  try {
    await refreshDatabase({ force: false })
  } catch {
    // The route loader will display an error if the user opens a data page.
  }
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
  const writingCount = state.database.questions.mcq.length
  const listingCount = (state.database.questions.listing || []).length
  const arrangeCount = (state.database.questions.arrange || []).length
  const masteredCount = state.database.vocabulary.filter((item) => (item.masteredCount || 0) >= MASTERED_THRESHOLD).length
  const needsReviewCount = vocabCount - masteredCount

  const wordTypeOrder = ['verb', 'adjective', 'noun', 'other']
  const wordTypeBreakdown = wordTypeOrder
    .map((value) => ({
      label: WORD_TYPE_LABELS[value],
      count: state.database.vocabulary.filter((item) => (item.wordType || 'other') === value).length,
    }))
    .filter((entry) => entry.count > 0)

  const exercises = [
    { route: '/exercise/mcq', icon: '☑', label: 'Trắc nghiệm' },
    { route: '/exercise/matching', icon: '⇄', label: 'Nối từ' },
    { route: '/exercise/fill', icon: '▭', label: 'Điền chỗ trống' },
    { route: '/exercise/writing', icon: '✎', label: 'Viết' },
    { route: '/exercise/listing', icon: '≡', label: 'Liệt kê' },
    { route: '/exercise/arrange', icon: '⇌', label: 'Sắp xếp câu' },
  ]

  return `
    <section class="page-card home-page">
      <div class="home-greeting">
        <h2>Xin chào! 👋</h2>
        <p class="muted">Hôm nay bạn muốn luyện tập gì?</p>
      </div>

      <div class="stat-grid home-stat-grid">
        <article class="home-stat-vocab"><strong>${vocabCount}</strong><span>Tổng từ vựng</span></article>
        <article class="home-stat-mastered"><strong>${masteredCount}</strong><span>Đã thuộc (≥${MASTERED_THRESHOLD} lần)</span></article>
        <article class="home-stat-review"><strong>${needsReviewCount}</strong><span>Cần ôn thêm</span></article>
      </div>

      <div class="home-section">
        <p class="group-title">Bắt đầu luyện tập</p>
        <div class="home-action-grid">
          ${exercises
      .map(
        (item) => `
            <button type="button" class="home-action-card" data-route="${item.route}">
              <span class="home-action-icon">${item.icon}</span>
              <span class="home-action-label">${item.label}</span>
            </button>
          `,
      )
      .join('')}
        </div>
      </div>

      ${wordTypeBreakdown.length
      ? `
      <div class="home-section">
        <p class="group-title">Từ theo loại</p>
        <div class="word-type-grid">
          ${wordTypeBreakdown
          .map((entry) => {
            const percent = vocabCount ? Math.round((entry.count / vocabCount) * 100) : 0
            return `
              <div class="word-type-row">
                <span class="word-type-row-label">${entry.label}</span>
                <div class="word-type-bar"><span class="word-type-bar-fill" style="width:${percent}%"></span></div>
                <span class="word-type-row-value">${entry.count} từ · ${percent}%</span>
              </div>
            `
          })
          .join('')}
        </div>
      </div>
      `
      : ''}
    </section>
  `
}

function renderArrangePage() {
  const items = state.database.questions.arrange || []
  const sessionIndexes = state.arrangeSessionIndexes || []
  const totalCount = sessionIndexes.length
  const currentIndex = Math.max(0, Math.min(state.arrangeCurrentIndex, Math.max(totalCount - 1, 0)))
  const activeQuestionIndex = sessionIndexes[currentIndex] ?? 0
  const currentItem = items[activeQuestionIndex]
  const wordBank = state.arrangeWordBanks[activeQuestionIndex] || []
  const selectedTokenIndexes = state.arrangeSelectedTokenIndexes[activeQuestionIndex] || []
  const typedAnswer = selectedTokenIndexes.map((index) => wordBank[index]).join(' ')
  const builtSentence = normalizeArrangeSentence(typedAnswer)
  const expectedSentence = normalizeArrangeSentence(currentItem?.answer)
  const currentChecked = Boolean(state.arrangeCheckedMap[activeQuestionIndex])
  const currentShowAnswer = Boolean(state.arrangeShowAnswerMap[activeQuestionIndex])
  const feedbackText = String(state.arrangeFeedbackMap[activeQuestionIndex] || '').trim()
  const allTokensSelected = wordBank.length > 0 && selectedTokenIndexes.length === wordBank.length
  const maxSelectable = Math.max(1, items.length || 1)
  const currentSelectable = clampQuestionCount(state.arrangeQuestionCount, maxSelectable)
  const setupVisible = state.arrangeSessionPhase !== 'playing' && state.arrangeSessionPhase !== 'completed'
  const completed = state.arrangeSessionPhase === 'completed'
  const answeredCount = sessionIndexes.filter((index) => {
    const bank = state.arrangeWordBanks[index] || []
    const selected = state.arrangeSelectedTokenIndexes[index] || []
    return bank.length > 0 && selected.length === bank.length
  }).length
  const canSubmit = totalCount > 0 && answeredCount === totalCount

  return `
    <section class="page-card focused-exercise">
      <header class="exercise-page-heading">
        <h2>Sắp xếp câu</h2>
        <span>Câu ${totalCount ? currentIndex + 1 : 0}/${totalCount}</span>
      </header>
      ${setupVisible
      ? `
          <article class="question-card compact">
            <label>
              Số lượng câu hỏi
              <input data-arrange-question-count type="number" min="1" max="${maxSelectable}" value="${currentSelectable}" />
            </label>
            <button type="button" class="action-btn" data-arrange-reset-session ${items.length ? '' : 'disabled'}>Bắt đầu làm bài</button>
          </article>
        `
      : ''}
      ${!setupVisible && currentItem
      ? `
            <article class="exercise-prompt-card">
              <span class="exercise-eyebrow">Nghĩa tiếng Việt</span>
              <strong>${escapeHtml(currentItem.prompt)}</strong>
              ${currentItem.hint ? `<p>${escapeHtml(currentItem.hint)}</p>` : ''}
            </article>

            <div class="arrange-drop-zone ${selectedTokenIndexes.length ? 'has-tokens' : ''}">
              ${selectedTokenIndexes.length
          ? selectedTokenIndexes.map((tokenIndex) => `
                  <button type="button" class="arrange-token selected" data-arrange-remove-token="${tokenIndex}" ${completed ? 'disabled' : ''}>
                    ${escapeHtml(wordBank[tokenIndex])}
                  </button>
                `).join('')
          : '<span>Nhấn từ bên dưới để thêm vào đây...</span>'}
            </div>

            <div class="arrange-token-bank">
              ${wordBank.map((word, tokenIndex) => `
                <button
                  type="button"
                  class="arrange-token"
                  data-arrange-add-token="${tokenIndex}"
                  ${selectedTokenIndexes.includes(tokenIndex) || completed ? 'disabled' : ''}
                >${escapeHtml(word)}</button>
              `).join('')}
            </div>

            ${feedbackText ? `<p class="notice ${currentChecked ? 'ok' : 'error'}">${escapeHtml(feedbackText)}</p>` : ''}
            ${(completed || currentShowAnswer)
          ? `
              <article class="arrange-answer-reveal">
                <span>Đáp án đúng</span>
                <strong>${escapeHtml(expectedSentence)}</strong>
              </article>
            `
          : ''}

            <div class="exercise-submit-row">
              <button type="button" class="exercise-reset-btn" data-arrange-clear-current aria-label="Làm lại" ${completed ? 'disabled' : ''}>↶</button>
              <button type="button" class="small-btn" data-arrange-prev ${currentIndex > 0 ? '' : 'disabled'}>Câu trước</button>
            </div>
            <div class="mcq-complete-actions">
              <button type="button" class="small-btn" data-arrange-next-question ${currentIndex + 1 < totalCount ? '' : 'disabled'}>Câu kế tiếp</button>
              <button type="button" class="small-btn" data-arrange-check-current ${allTokensSelected ? '' : 'disabled'}>Kiểm tra câu này</button>
              ${!completed
          ? `<button type="button" class="small-btn arrange-show-answer-btn" data-arrange-show-answer>${currentShowAnswer ? 'Ẩn đáp án' : 'Xem đáp án đúng'}</button>`
          : ''}
            </div>

            ${completed
          ? '<button type="button" class="small-btn exercise-next-btn" data-arrange-reset-session>Làm bộ câu mới</button>'
          : canSubmit
            ? '<button type="button" class="action-btn exercise-check-btn" data-arrange-submit>Kiểm tra kết quả</button>'
            : `<button type="button" class="action-btn exercise-check-btn" data-arrange-submit disabled>Kiểm tra kết quả</button>`}
          `
      : setupVisible ? '' : '<p class="muted">Chưa có câu hỏi sắp xếp nào.</p>'}
    </section>
  `
}

function renderFillPage() {
  const items = state.database.questions.fillBlank || []
  const sessionIndexes = state.fillSessionIndexes || []
  const totalCount = sessionIndexes.length
  const currentIndex = Math.max(0, Math.min(state.fillCurrentIndex, Math.max(totalCount - 1, 0)))
  const activeQuestionIndex = sessionIndexes[currentIndex] ?? 0
  const item = items[activeQuestionIndex]
  const answer = state.blankAnswers[activeQuestionIndex] || ''
  const checked = Boolean(state.fillCheckedMap[activeQuestionIndex])
  const feedback = state.fillFeedbackMap[activeQuestionIndex] || ''
  const maxSelectable = Math.max(1, items.length || 1)
  const currentSelectable = clampQuestionCount(state.fillQuestionCount, maxSelectable)
  const setupVisible = state.fillSessionPhase !== 'playing' && state.fillSessionPhase !== 'completed'
  const completed = state.fillSessionPhase === 'completed'
  const answeredCount = sessionIndexes.filter((index) => String(state.blankAnswers[index] || '').trim()).length
  const canSubmit = totalCount > 0 && answeredCount === totalCount

  return `
    <section class="page-card focused-exercise">
      <header class="exercise-page-heading">
        <h2>Điền chỗ trống</h2>
        <span>${totalCount ? currentIndex + 1 : 0}/${totalCount}</span>
      </header>
      ${setupVisible
      ? `
          <article class="question-card compact">
            <label>
              Số lượng câu hỏi
              <input data-fill-question-count type="number" min="1" max="${maxSelectable}" value="${currentSelectable}" />
            </label>
            <button type="button" class="action-btn" data-fill-start ${items.length ? '' : 'disabled'}>Bắt đầu làm bài</button>
          </article>
        `
      : ''}
      ${!setupVisible && item
      ? `
          <article class="exercise-prompt-card fill-prompt-card">
            <span class="exercise-eyebrow">Nghĩa của từ cần điền</span>
            <strong>${escapeHtml(item.hint || 'Điền từ thích hợp vào chỗ trống')}</strong>
            <p class="fill-sentence">${escapeHtml(item.sentence).replace('___', '<span class="blank-mark">________</span>')}</p>
          </article>
          <input
            class="exercise-answer-input"
            data-blank-index="${activeQuestionIndex}"
            type="text"
            value="${escapeHtml(answer)}"
            placeholder="Nhập từ tiếng Anh..."
            autocomplete="off"
            ${completed ? 'disabled' : ''}
          />
          ${feedback ? `<p class="notice ${checked ? 'ok' : 'error'}" data-fill-feedback>${escapeHtml(feedback)}</p>` : ''}
          ${(completed || feedback) && item.answer
          ? `<article class="writing-answer-reveal" data-fill-answer>
              <span>Đáp án đúng</span>
              <strong>${escapeHtml(item.answer || '')}</strong>
            </article>`
          : ''}
          <p class="muted">Đã trả lời: <strong>${answeredCount}/${totalCount}</strong> câu.</p>
          <div class="mcq-complete-actions">
            <button type="button" class="small-btn" data-fill-prev ${currentIndex > 0 ? '' : 'disabled'}>Câu trước</button>
            <button type="button" class="small-btn" data-fill-next-question ${currentIndex + 1 < totalCount ? '' : 'disabled'}>Câu kế tiếp</button>
            <button type="button" class="small-btn" data-fill-check ${answer.trim() ? '' : 'disabled'}>Kiểm tra câu này</button>
          </div>
          ${completed
          ? '<button type="button" class="small-btn" data-fill-reset-session>Làm bộ câu mới</button>'
          : canSubmit
            ? '<button type="button" class="action-btn exercise-check-btn" data-fill-submit>Kiểm tra kết quả</button>'
            : '<button type="button" class="action-btn exercise-check-btn" data-fill-submit disabled>Kiểm tra kết quả</button>'}
        `
      : setupVisible ? '' : '<p class="muted">Chưa có câu hỏi điền chỗ trống nào.</p>'}
    </section>
  `
}

function renderMcqPage() {
  const questions = state.mcqQuizQuestions
  const score = scoreMcq()
  const answeredCount = state.mcqAnswers.filter((answer) => String(answer || '').trim().length > 0).length
  const availableCount = state.mcqPoolQuestions.length
  const hiddenCorrectCount = state.mcqCorrectQuestionIds.length
  const selectedCount = clampQuestionCount(state.mcqQuestionCount, availableCount)
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
  const currentAnswerShown = Boolean(state.mcqShowAnswerMap[state.mcqCurrentIndex])

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
          <input data-mcq-question-count type="number" min="1" max="${Math.max(1, availableCount || 1)}" value="${selectedCount}" />
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
          <button type="button" class="small-btn" data-mcq-show-current-answer>
            ${currentAnswerShown ? 'Ẩn đáp án' : 'Xem đáp án đúng'}
          </button>
        </div>
        ${currentAnswerShown
          ? `<article class="writing-answer-reveal">
              <span>Đáp án đúng</span>
              <strong>${escapeHtml(currentQuestion.answer)}</strong>
            </article>`
          : ''}
        ${canSubmit
          ? '<button type="button" class="action-btn" data-check-result="mcq">Kiểm tra kết quả</button>'
          : '<button type="button" class="action-btn" data-check-result="mcq" disabled>Kiểm tra kết quả</button>'}
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
                <article class="writing-answer-reveal">
                  <span>Đáp án đúng</span>
                  <strong>${escapeHtml(item.answer)}</strong>
                </article>
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
  const selectedLeftId = Number(state.matchingSelectedLeftId)
  const rightOwnershipMap = Object.entries(state.matchingPairs).reduce((map, [leftId, rightId]) => {
    map[String(rightId)] = Number(leftId)
    return map
  }, {})
  const connectedCount = Object.keys(state.matchingPairs).length
  const isComplete = isMatchingRoundComplete()
  const setupVisible = state.matchingSessionPhase !== 'playing'
  const maxSelectable = Math.max(1, items.length || 1)
  const currentSelectable = clampQuestionCount(state.matchingQuestionCount, maxSelectable)

  return `
    <section class="page-card focused-exercise matching-exercise">
      <header class="exercise-page-heading">
        <h2>Nối từ</h2>
        <span>${connectedCount}/${leftColumn.length} đã nối</span>
      </header>
      ${setupVisible
      ? `
          <article class="question-card compact">
            <label>
              Số lượng cặp từ
              <input data-matching-question-count type="number" min="1" max="${maxSelectable}" value="${currentSelectable}" />
            </label>
            <button type="button" class="action-btn" data-matching-start ${items.length ? '' : 'disabled'}>Bắt đầu làm bài</button>
          </article>
        `
      : ''}
      ${!setupVisible && leftColumn.length
      ? `
          <div class="matching-board-wrap">
            <svg class="matching-lines" data-matching-lines aria-hidden="true"></svg>
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
          </div>
          <div class="mcq-complete-actions">
            <button type="button" class="action-btn exercise-check-btn" data-matching-check-result ${isComplete ? '' : 'disabled'}>Kiểm tra kết quả</button>
            <button type="button" class="small-btn" data-matching-show-answer>${state.matchingShowAnswer ? 'Ẩn đáp án' : 'Xem đáp án đúng'}</button>
          </div>
          ${(state.matchingChecked || state.matchingShowAnswer)
          ? `
            <article class="matching-answer-reveal">
              <span>Đáp án đúng</span>
              ${leftColumn.map((item) => `
                <p>
                  <strong>${escapeHtml(item.word)}</strong>
                  <span>${escapeHtml(item.meaning)}</span>
                </p>
              `).join('')}
            </article>
          `
          : ''}
          <button type="button" class="small-btn exercise-next-btn" data-matching-reset-session>${state.matchingChecked ? 'Làm bộ từ mới' : 'Đổi bộ từ'}</button>
        `
      : setupVisible ? '' : '<p class="muted">Chưa có dữ liệu từ nối nào.</p>'}
    </section>
  `
}

function renderWritingPage() {
  const items = state.database.questions.mcq || []
  const sessionIndexes = state.writingSessionIndexes || []
  const totalCount = sessionIndexes.length
  const currentIndex = Math.max(0, Math.min(state.writingCurrentIndex, Math.max(totalCount - 1, 0)))
  const activeQuestionIndex = sessionIndexes[currentIndex] ?? 0
  const item = items[activeQuestionIndex]
  const answer = state.writingAnswers[activeQuestionIndex] || ''
  const checked = Boolean(state.writingCheckedMap[activeQuestionIndex])
  const feedback = state.writingFeedbackMap[activeQuestionIndex] || ''
  const maxSelectable = Math.max(1, items.length || 1)
  const currentSelectable = clampQuestionCount(state.writingQuestionCount, maxSelectable)
  const setupVisible = state.writingSessionPhase !== 'playing' && state.writingSessionPhase !== 'completed'
  const completed = state.writingSessionPhase === 'completed'
  const shouldShowCorrectAnswer = Boolean((completed || feedback) && item?.answer)
  const answeredCount = sessionIndexes.filter((index) => String(state.writingAnswers[index] || '').trim()).length
  const canSubmit = totalCount > 0 && answeredCount === totalCount

  return `
    <section class="page-card focused-exercise">
      <header class="exercise-page-heading">
        <h2>Viết câu trả lời</h2>
        <span>${totalCount ? currentIndex + 1 : 0}/${totalCount}</span>
      </header>
      ${setupVisible
      ? `
          <article class="question-card compact">
            <label>
              Số lượng câu hỏi
              <input data-writing-question-count type="number" min="1" max="${maxSelectable}" value="${currentSelectable}" />
            </label>
            <button type="button" class="action-btn" data-writing-start ${items.length ? '' : 'disabled'}>Bắt đầu làm bài</button>
          </article>
        `
      : ''}
      ${!setupVisible && item
      ? `
          <article class="exercise-prompt-card">
            <span class="exercise-eyebrow">Câu hỏi</span>
            <strong>${escapeHtml(item.question)}</strong>
          </article>
          <textarea
            class="writing-answer-input"
            data-writing-index="${activeQuestionIndex}"
            rows="4"
            placeholder="Nhập câu trả lời của bạn..."
            ${completed ? 'disabled' : ''}
          >${escapeHtml(answer)}</textarea>
          ${feedback ? `<p class="notice ${checked ? 'ok' : 'error'}" data-writing-feedback>${escapeHtml(feedback)}</p>` : ''}
          ${shouldShowCorrectAnswer
          ? `<article class="writing-answer-reveal" data-writing-answer>
              <span>Đáp án đúng</span>
              <strong>${escapeHtml(item.answer)}</strong>
            </article>`
          : ''}
          <p class="muted">Đã trả lời: <strong>${answeredCount}/${totalCount}</strong> câu.</p>
          <div class="mcq-complete-actions">
            <button type="button" class="small-btn" data-writing-prev ${currentIndex > 0 ? '' : 'disabled'}>Câu trước</button>
            <button type="button" class="small-btn" data-writing-next-question ${currentIndex + 1 < totalCount ? '' : 'disabled'}>Câu kế tiếp</button>
            <button type="button" class="small-btn" data-writing-check ${answer.trim() ? '' : 'disabled'}>Kiểm tra câu này</button>
          </div>
          ${completed
          ? '<button type="button" class="small-btn" data-writing-reset-session>Làm bộ câu mới</button>'
          : canSubmit
            ? '<button type="button" class="action-btn exercise-check-btn" data-writing-submit>Kiểm tra kết quả</button>'
            : '<button type="button" class="action-btn exercise-check-btn" data-writing-submit disabled>Kiểm tra kết quả</button>'}
        `
      : setupVisible ? '' : '<p class="muted">Chưa có dữ liệu câu hỏi + câu trả lời.</p>'}
    </section>
  `
}

function renderListingPage() {
  const items = state.database.questions.listing || []
  const scores = scoreListing()
  const preparedItems = getListingPreparedItems()
  const sessionIndexes = state.listingSessionIndexes || []
  const totalCount = sessionIndexes.length
  const currentIndex = Math.max(0, Math.min(state.listingCurrentIndex, Math.max(totalCount - 1, 0)))
  const activeQuestionIndex = sessionIndexes[currentIndex] ?? 0
  const currentItem = items[activeQuestionIndex]
  const currentPreparedItem = preparedItems[activeQuestionIndex] || { expectedEntries: [] }
  const currentExpectedEntries = currentPreparedItem.expectedEntries || []
  const currentScore = scores[activeQuestionIndex] || { percent: 0, hitCount: 0, total: 0, ideaDetails: [] }
  const currentChecked = Boolean(state.listingCheckedMap[activeQuestionIndex])
  const currentShowAnswer = Boolean(state.listingShowAnswerMap[activeQuestionIndex])
  const checkedCount = sessionIndexes.filter((index) => state.listingCheckedMap[index]).length
  const maxSelectable = Math.max(1, getUniqueListingQuestionIndexes(items.length).length || items.length || 1)
  const currentSelectable = clampQuestionCount(state.listingQuestionCount, maxSelectable)
  const totalCorrectCount = sessionIndexes.reduce((sum, index) => sum + (scores[index]?.hitCount || 0), 0)
  const totalItemCount = sessionIndexes.reduce((sum, index) => sum + (scores[index]?.total || 0), 0)
  const setupVisible = state.listingSessionPhase !== 'playing' && state.listingSessionPhase !== 'completed'
  const completed = state.listingSessionPhase === 'completed'
  const canSubmit = totalCount > 0

  return `
    <section class="page-card">
      <h2>Liệt kê ý</h2>
      ${setupVisible
      ? `
          <article class="question-card compact">
            <label>
              Số lượng câu liệt kê
              <input data-listing-question-count type="number" min="1" max="${maxSelectable}" value="${currentSelectable}" />
            </label>
            <button type="button" class="action-btn" data-listing-reset-session ${items.length ? '' : 'disabled'}>Bắt đầu làm bài</button>
          </article>
        `
      : ''}
      ${!setupVisible && currentItem
      ? `
            <article class="question-card">
              <h3 class="question-title">
                <span class="question-order">Câu ${currentIndex + 1}/${totalCount}</span>
                <span class="question-text">${escapeHtml(currentItem.prompt)}</span>
              </h3>
              <p class="question-hint">${escapeHtml(currentItem.hint || 'Liệt kê các ý theo từng dòng.')}</p>
              <p class="muted">Mỗi dòng là 1 ý. Khi kiểm tra, đáp án mẫu sẽ hiện ra để bạn tự đối chiếu.</p>
              <textarea data-listing-index="${activeQuestionIndex}" rows="6" placeholder="- Ý 1&#10;- Ý 2&#10;- Ý 3" ${completed ? 'disabled' : ''}>${escapeHtml(state.listingAnswers[activeQuestionIndex] || '')}</textarea>
              ${completed ? `<p class="muted">Đã khớp: <strong>${currentScore.hitCount}/${currentScore.total}</strong> ý</p>` : ''}
              ${currentChecked
      ? `
                <div class="listing-review-block">
                  <p class="muted"><strong>Đáp án đúng và đối chiếu chi tiết:</strong></p>
                  ${(currentScore.ideaDetails || [])
      .map((detail) => `
                      <article class="listing-review-item ${detail.isCorrect ? 'ok' : 'wrong'}">
                        <p><strong>Bạn nhập:</strong> ${escapeHtml(detail.user || '(trống)')}</p>
                        <p><strong>Kết quả:</strong> ${detail.isCorrect ? 'Đúng' : 'Chưa khớp với ý nào'}</p>
                        ${detail.expected ? `<p class="muted"><strong>Ý chuẩn khớp:</strong> ${escapeHtml(detail.expected)}</p>` : ''}
                      </article>
                    `)
      .join('')}
                </div>
              `
      : ''}
              ${currentShowAnswer
      ? `
                <div class="listing-review-block">
                  <p class="muted"><strong>Đáp án đúng:</strong></p>
                  ${currentExpectedEntries.length
        ? currentExpectedEntries
          .map((entry, index) => `
                        <article class="listing-review-item ok">
                          <p><strong>Ý ${index + 1}:</strong> ${escapeHtml(entry.raw)}</p>
                        </article>
                      `)
          .join('')
        : '<article class="listing-review-item"><p>Chưa có đáp án mẫu cho câu này.</p></article>'}
                </div>
              `
              : ''}
            </article>
            <div class="mcq-complete-actions">
              <button type="button" class="small-btn" data-listing-prev ${currentIndex > 0 ? '' : 'disabled'}>Câu trước</button>
              <button type="button" class="small-btn" data-listing-next-question ${currentIndex + 1 < totalCount ? '' : 'disabled'}>Câu kế tiếp</button>
              <button type="button" class="small-btn" data-listing-check-current>Kiểm tra câu này</button>
              <button type="button" class="small-btn" data-listing-show-answer>${currentShowAnswer ? 'Ẩn đáp án' : 'Xem đáp án đúng'}</button>
            </div>
            ${completed
        ? '<button type="button" class="small-btn" data-listing-reset-session>Làm bộ câu mới</button>'
        : canSubmit
          ? '<button type="button" class="action-btn" data-listing-submit>Kiểm tra kết quả</button>'
          : `<button type="button" class="action-btn" data-listing-submit disabled>Kiểm tra kết quả</button>`}
          `
      : setupVisible ? '' : '<p class="muted">Chưa có câu hỏi liệt kê nào.</p>'}
      ${!setupVisible ? `<p class="score-line">Đã kiểm tra: <strong>${checkedCount}/${totalCount}</strong> câu</p>` : ''}
      ${completed ? `<p class="score-line">Tổng ý đúng: <strong>${totalCorrectCount}/${totalItemCount}</strong> ý</p>` : ''}
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
                    <button type="button" class="small-btn" data-edit-source-matching="${item.id}">Sửa</button>
                    <button type="button" class="small-btn danger" data-delete-source-matching="${item.id}">Xóa</button>
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
        <label>Loại từ
          <select name="wordType">
            ${WORD_TYPE_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join('')}
          </select>
        </label>
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
                  <span class="word-type-tag">${escapeHtml(WORD_TYPE_LABELS[item.wordType] || WORD_TYPE_LABELS.other)}</span>
                  <p>${escapeHtml(item.definition)}</p>
                </div>
                <div class="row-actions">
                  <button type="button" class="small-btn" data-edit-vocab="${item.id}">Sửa</button>
                  <button type="button" class="small-btn danger" data-delete-vocab="${item.id}">Xóa</button>
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

function renderSourceQuestion() {
  const questionAnswerList = state.database.questions.mcq || []
  const fillBlankQuestionList = state.database.questions.fillBlank || []
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
  const arrangeQuestionList = (state.database.questions.arrange || []).map((item) => ({
    id: item.id,
    questionType: 'arrange',
    prompt: item.prompt,
    hint: item.hint,
    answer: item.answer || '',
  }))
  const sharedListQuestions = [...writingQuestionList, ...listingQuestionList]
    .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))

  return `
    <section class="page-card">
      <h2>Nhiệm vụ: Thêm câu hỏi + câu trả lời</h2>
      <form id="question-form" class="stack-form">
        <p class="muted">Nhập câu hỏi và đáp án để lưu vào cơ sở dữ liệu câu hỏi.</p>
        <label>
          Loại câu hỏi
          <select name="type" required>
            <option value="mcq">Câu hỏi + đáp án</option>
            <option value="fillBlank">Điền chỗ trống</option>
          </select>
        </label>
        <label>Câu hỏi<input name="question" required placeholder="Ví dụ: Nghĩa của từ resilient là gì?" /></label>
        <label>Đáp án đúng<input name="answer" required placeholder="Có khả năng phục hồi nhanh sau khó khăn hoặc từ cần điền" /></label>
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

      <h3>Thêm câu hỏi sắp xếp câu</h3>
      <form id="arrange-question-form" class="stack-form">
        <label>Nội dung câu hỏi<input name="prompt" required placeholder="Sắp xếp thành câu đúng: I / like / apples" /></label>
        <label>Gợi ý<input name="hint" placeholder="Bắt đầu bằng chữ I" /></label>
        <label>Câu đúng<input name="answer" required placeholder="I like apples." /></label>
        <button type="submit">Lưu câu hỏi sắp xếp</button>
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
                    <button type="button" class="small-btn" data-edit-question="mcq:${item.id}">Sửa</button>
                    <button type="button" class="small-btn danger" data-delete-question="mcq:${item.id}">Xóa</button>
                  </div>
                </article>
              `,
            )
            .join('')
          : '<p class="muted">Chưa có câu hỏi/câu trả lời nào.</p>'}
      </div>

      <h3>Quản lý câu điền chỗ trống (sửa/xóa)</h3>
      <div class="manage-list">
        ${fillBlankQuestionList.length
          ? fillBlankQuestionList
            .map(
              (item) => `
                <article class="manage-card">
                  <div>
                    <strong>${escapeHtml(item.sentence)}</strong>
                    <p class="muted">Đáp án: ${escapeHtml(item.answer)}</p>
                  </div>
                  <div class="row-actions">
                    <button type="button" class="small-btn" data-edit-question="fillBlank:${item.id}">Sửa</button>
                    <button type="button" class="small-btn danger" data-delete-question="fillBlank:${item.id}">Xóa</button>
                  </div>
                </article>
              `,
            )
            .join('')
          : '<p class="muted">Chưa có câu điền chỗ trống nào.</p>'}
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
                    <button type="button" class="small-btn" data-edit-shared-list-question="${item.questionType}:${item.id}">Sửa</button>
                    <button type="button" class="small-btn danger" data-delete-shared-list-question="${item.questionType}:${item.id}">Xóa</button>
                  </div>
                </article>
              `,
            )
            .join('')
          : '<p class="muted">Chưa có câu hỏi liệt kê dùng chung nào.</p>'}
      </div>

      <h3>Quản lý câu hỏi sắp xếp (sửa/xóa)</h3>
      <div class="manage-list">
        ${arrangeQuestionList.length
          ? arrangeQuestionList
            .map(
              (item) => `
                <article class="manage-card">
                  <div>
                    <strong>${escapeHtml(item.prompt)}</strong>
                    <p>${escapeHtml(item.hint)}</p>
                    <p class="muted">Đáp án đúng: ${escapeHtml(item.answer)}</p>
                  </div>
                  <div class="row-actions">
                    <button type="button" class="small-btn" data-edit-arrange-question="${item.id}">Sửa</button>
                    <button type="button" class="small-btn danger" data-delete-arrange-question="${item.id}">Xóa</button>
                  </div>
                </article>
              `,
            )
            .join('')
          : '<p class="muted">Chưa có câu hỏi sắp xếp nào.</p>'}
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
  if (state.route === '/welcome') return renderLandingPage()
  if (state.route === '/home') return renderLayout(renderHome())
  if (state.route === '/exercise/mcq') return renderLayout(renderMcqPage())
  if (state.route === '/exercise/matching') return renderLayout(renderMatchingPage())
  if (state.route === '/exercise/fill') return renderLayout(renderFillPage())
  if (state.route === '/exercise/writing') return renderLayout(renderWritingPage())
  if (state.route === '/exercise/listing') return renderLayout(renderListingPage())
  if (state.route === '/exercise/arrange') return renderLayout(renderArrangePage())
  if (state.route === '/source/vocab') return renderLayout(renderSourceVocab())
  if (state.route === '/source/questions') return renderLayout(renderSourceQuestion())
  if (state.route === '/source/matching') return renderLayout(renderSourceMatching())
  return renderLandingPage()
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
      state.listingQuestionCount = clampQuestionCount(target.value, getUniqueListingQuestionIndexes().length)
      state.listingSessionIndexes = []
      state.listingSessionPhase = 'setup'
      return
    }

    if (target.matches('[data-arrange-question-count]')) {
      state.arrangeQuestionCount = clampQuestionCount(target.value, (state.database.questions.arrange || []).length)
      state.arrangeSessionIndexes = []
      state.arrangeSessionPhase = 'setup'
      return
    }

    if (target.matches('[data-matching-question-count]')) {
      state.matchingQuestionCount = clampQuestionCount(target.value, (state.database.questions.matching || []).length)
      clearMatchingSession()
      return
    }

    if (target.matches('[data-mcq-source-mode]')) {
      state.mcqSourceMode = target.value
      await loadDataForCurrentRoute()
      return
    }

    if (target.matches('[data-mcq-question-count]')) {
      state.mcqQuestionCount = clampQuestionCount(target.value, state.mcqPoolQuestions.length)
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
      const index = Number(target.dataset.blankIndex)
      state.blankAnswers[index] = target.value
      state.fillCheckedMap[index] = false
      state.fillFeedbackMap[index] = ''
      const checkButton = app.querySelector('[data-fill-check]')
      if (checkButton) checkButton.disabled = !target.value.trim()
      app.querySelector('[data-fill-feedback]')?.remove()
      app.querySelector('[data-fill-answer]')?.remove()
      app.querySelector('[data-fill-next-button]')?.remove()
      return
    }

    if (target.matches('textarea[data-writing-index]')) {
      const index = Number(target.dataset.writingIndex)
      state.writingAnswers[index] = target.value
      state.writingCheckedMap[index] = false
      state.writingFeedbackMap[index] = ''
      state.writingScoreDirty = true
      const checkButton = app.querySelector('[data-writing-check]')
      if (checkButton) checkButton.disabled = !target.value.trim()
      app.querySelector('[data-writing-feedback]')?.remove()
      app.querySelector('[data-writing-answer]')?.remove()
      app.querySelector('[data-writing-next-button]')?.remove()
      return
    }

    if (target.matches('textarea[data-listing-index]')) {
      const index = Number(target.dataset.listingIndex)
      state.listingAnswers[index] = target.value
      state.listingCheckedMap[index] = false
      state.listingShowAnswerMap[index] = false
      state.listingScoreDirty = true
      return
    }

    if (target.matches('textarea[data-arrange-index]')) {
      const index = Number(target.dataset.arrangeIndex)
      state.arrangeTypedAnswers[index] = target.value
      state.arrangeCheckedMap[index] = false
      state.arrangeShowAnswerMap[index] = false
      state.arrangeFeedbackMap[index] = ''

      const preview = app.querySelector('[data-arrange-preview]')
      if (preview) {
        preview.textContent = normalizeArrangeSentence(target.value) || '(trống)'
      }

      const clearButton = app.querySelector('[data-arrange-clear-current]')
      if (clearButton) {
        clearButton.disabled = !target.value.trim()
      }

      app.querySelector('[data-arrange-feedback]')?.remove()
      app.querySelector('[data-arrange-result]')?.remove()
      app.querySelector('[data-arrange-answer]')?.remove()

      const primaryButton = app.querySelector('[data-arrange-primary-action]')
      if (primaryButton) {
        primaryButton.removeAttribute('data-arrange-next-question')
        primaryButton.setAttribute('data-arrange-check-current', '')
        primaryButton.textContent = 'Kiểm tra câu hiện tại'
      }
    }
  })

  app.addEventListener('submit', async (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return

    if (form.matches('[data-edit-dialog-form]')) {
      event.preventDefault()
      const formData = new FormData(form)

      try {
        const updated = await submitEditDialog(formData)
        if (!updated) {
          state.sourceMessage = 'Bạn cần điền đủ dữ liệu trước khi lưu.'
          state.sourceMessageType = 'error'
          render()
          return
        }

        clearDatabaseCache()
        await refreshDatabase({ force: true })
        resetExerciseState()
        state.sourceMessage = 'Đã cập nhật dữ liệu.'
        state.sourceMessageType = 'ok'
        render()
      } catch (error) {
        state.sourceMessage = error.message || 'Có lỗi khi cập nhật dữ liệu.'
        state.sourceMessageType = 'error'
        render()
      }
      return
    }

    if (form.id === 'vocab-form') {
      event.preventDefault()
      const formData = new FormData(form)

      withRefresh(
        async () => {
          await createVocabulary({
            word: String(formData.get('word') || '').trim(),
            definition: String(formData.get('definition') || '').trim(),
            example: String(formData.get('example') || '').trim(),
            wordType: String(formData.get('wordType') || 'other').trim(),
          })
          form.reset()
        },
        'Đã thêm từ vựng vào cơ sở dữ liệu SQLite.',
      )
      return
    }

    if (form.id === 'matching-form') {
      event.preventDefault()
      const formData = new FormData(form)

      withRefresh(
        async () => {
          await createQuestion({
            type: 'matching',
            word: String(formData.get('word') || '').trim(),
            meaning: String(formData.get('meaning') || '').trim(),
          })
          form.reset()
        },
        'Đã thêm từ nối vào cơ sở dữ liệu.',
      )
      return
    }

    if (form.id === 'question-form') {
      event.preventDefault()
      const formData = new FormData(form)
      const payload = parseQuestionPayload(formData)

      withRefresh(
        async () => {
          await createQuestion(payload)
          form.reset()
        },
        'Đã lưu câu hỏi vào cơ sở dữ liệu.',
      )
      return
    }

    if (form.id === 'shared-list-question-form') {
      event.preventDefault()
      const formData = new FormData(form)
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
          form.reset()
        },
        'Đã lưu câu hỏi liệt kê dùng chung.',
      )
      return
    }

    if (form.id === 'arrange-question-form') {
      event.preventDefault()
      const formData = new FormData(form)
      const prompt = String(formData.get('prompt') || '').trim()
      const hint = String(formData.get('hint') || '').trim()
      const answer = normalizeArrangeSentence(formData.get('answer'))

      if (!prompt || !answer) {
        state.sourceMessage = 'Bạn cần nhập đầy đủ câu hỏi và câu đúng cho bài sắp xếp.'
        state.sourceMessageType = 'error'
        render()
        return
      }

      withRefresh(
        async () => {
          await createQuestion({
            type: 'arrange',
            prompt,
            hint,
            answer,
          })
          form.reset()
        },
        'Đã lưu câu hỏi sắp xếp.',
      )
    }
  })

  app.addEventListener('focusout', (event) => {
    const target = event.target

    if (target.matches('textarea[data-writing-index]')) {
      const index = Number(target.dataset.writingIndex)
      if (state.writingAnswers[index] !== target.value) {
        state.writingAnswers[index] = target.value
      }
      return
    }

    if (target.matches('textarea[data-listing-index]')) {
      const index = Number(target.dataset.listingIndex)
      if (state.listingAnswers[index] !== target.value) {
        state.listingAnswers[index] = target.value
      }
    }
  })

  app.addEventListener('click', async (event) => {
    const target = event.target
    const button = target.closest('button')

    if (target.matches('.quick-board-overlay')) {
      state.slideBoardOpen = false
      render()
      return
    }

    if (target.matches('[data-fill-question-count]')) {
      state.fillQuestionCount = clampQuestionCount(target.value, (state.database.questions.fillBlank || []).length)
      state.fillSessionIndexes = []
      state.fillSessionPhase = 'setup'
      return
    }

    if (target.matches('[data-writing-question-count]')) {
      state.writingQuestionCount = clampQuestionCount(target.value, (state.database.questions.mcq || []).length)
      state.writingSessionIndexes = []
      state.writingSessionPhase = 'setup'
      return
    }

    if (button?.matches('[data-route]')) {
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
      return
    }

    if (button?.matches('[data-menu-scroll]')) {
      const direction = button.dataset.menuScroll === 'up' ? -1 : 1
      const menuScrollBox = app.querySelector('[data-sidebar-scroll]')
      if (!menuScrollBox) return
      menuScrollBox.scrollBy({
        top: direction * 220,
        behavior: 'smooth',
      })
      return
    }

    if (button?.matches('[data-toggle-slide-board]')) {
      state.slideBoardOpen = !state.slideBoardOpen
      render()
      return
    }

    if (button?.matches('[data-toggle-source-group]')) {
      state.sourceGroupOpen = !state.sourceGroupOpen
      render()
      return
    }

    if (button?.matches('[data-toggle-menu]')) {
      state.sidebarOpen = !state.sidebarOpen
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(state.sidebarOpen))
      state.slideBoardOpen = false
      render()
      return
    }

    if (button?.matches('[data-delete-vocab]')) {
      const id = normalizeEntityId(button.dataset.deleteVocab)
      if (!id) return
      withRefresh(
        async () => {
          await deleteVocabulary(id)
        },
        'Đã xóa từ vựng.',
      )
      return
    }

    if (button?.matches('[data-delete-source-matching]')) {
      const id = normalizeEntityId(button.dataset.deleteSourceMatching)
      if (!id) return
      withRefresh(
        async () => {
          await deleteQuestion('matching', id)
        },
        'Đã xóa từ nối.',
      )
      return
    }

    if (button?.matches('[data-delete-question-answer]')) {
      const id = normalizeEntityId(button.dataset.deleteQuestionAnswer)
      if (!id) return
      withRefresh(
        async () => {
          await deleteQuestion('mcq', id)
        },
        'Đã xóa câu hỏi/câu trả lời.',
      )
      return
    }

    if (button?.matches('[data-delete-shared-list-question]')) {
      const token = String(button.dataset.deleteSharedListQuestion || '')
      const [questionType, rawId] = token.split(':')
      const id = normalizeEntityId(rawId)
      if (!id) return

      withRefresh(
        async () => {
          await deleteQuestion(questionType === 'writing' ? 'writing' : 'listing', id)
        },
        'Đã xóa câu hỏi liệt kê dùng chung.',
      )
      return
    }

    if (button?.matches('[data-delete-arrange-question]')) {
      const id = normalizeEntityId(button.dataset.deleteArrangeQuestion)
      if (!id) return

      withRefresh(
        async () => {
          await deleteQuestion('arrange', id)
        },
        'Đã xóa câu hỏi sắp xếp.',
      )
      return
    }

    if (button?.matches('[data-delete-question]')) {
      const token = String(button.dataset.deleteQuestion || '')
      const [questionType, rawId] = token.split(':')
      const id = normalizeEntityId(rawId)
      if (!questionType || !id) return

      withRefresh(
        async () => {
          await deleteQuestion(questionType, id)
        },
        'Đã xóa câu hỏi.',
      )
      return
    }

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
      if (!state.listingSessionIndexes.length) return
      const activeIndex = state.listingSessionIndexes[state.listingCurrentIndex] ?? 0
      state.listingCheckedMap[activeIndex] = true
      state.listingShowAnswerMap[activeIndex] = true
      state.listingScoreDirty = true
      render()
      return
    }

    if (button?.matches('[data-listing-prev]')) {
      if (state.listingCurrentIndex <= 0) return
      state.listingCurrentIndex -= 1
      render()
      return
    }

    if (button?.matches('[data-listing-submit]')) {
      if (!state.listingSessionIndexes.length) return
      gradeListingSession()
      openResultNotice('listing')
      return
    }

    if (button?.matches('[data-listing-show-answer]')) {
      if (!state.listingSessionIndexes.length) return
      const activeIndex = state.listingSessionIndexes[state.listingCurrentIndex] ?? 0
      state.listingShowAnswerMap[activeIndex] = !state.listingShowAnswerMap[activeIndex]
      render()
      return
    }

    if (button?.matches('[data-listing-skip-question]')) {
      const uncheckedIndexes = state.listingSessionIndexes
        .filter((index) => !state.listingCheckedMap[index])
        .filter((index) => index !== state.listingSessionIndexes[state.listingCurrentIndex])

      if (!uncheckedIndexes.length) return

      const prevIndex = state.listingSessionIndexes[state.listingCurrentIndex] ?? 0
      const randomIndex = Math.floor(Math.random() * uncheckedIndexes.length)
      const nextQuestionIndex = uncheckedIndexes[randomIndex]
      state.listingCurrentIndex = state.listingSessionIndexes.findIndex((index) => index === nextQuestionIndex)
      state.listingShowAnswerMap[prevIndex] = false
      render()
      return
    }

    if (button?.matches('[data-listing-next-question]')) {
      if (state.listingSessionPhase === 'playing' || state.listingSessionPhase === 'completed') {
        if (state.listingCurrentIndex + 1 >= state.listingSessionIndexes.length) return
        state.listingCurrentIndex += 1
        render()
        return
      }

      const uncheckedIndexes = state.listingSessionIndexes
        .filter((index) => !state.listingCheckedMap[index])

      if (!uncheckedIndexes.length) return

      const randomIndex = Math.floor(Math.random() * uncheckedIndexes.length)
      const nextQuestionIndex = uncheckedIndexes[randomIndex]
      const prevIndex = state.listingSessionIndexes[state.listingCurrentIndex] ?? 0
      state.listingCurrentIndex = state.listingSessionIndexes.findIndex((index) => index === nextQuestionIndex)
      state.listingShowAnswerMap[prevIndex] = false
      render()
      return
    }

    if (button?.matches('[data-listing-reset-session]')) {
      resetListingSession((state.database.questions.listing || []).length)
      render()
      return
    }

    if (button?.matches('[data-fill-start]') || button?.matches('[data-fill-reset-session]')) {
      state.resultNotice = null
      startFillSession()
      render()
      return
    }

    if (button?.matches('[data-fill-prev]')) {
      if (state.fillCurrentIndex <= 0) return
      state.fillCurrentIndex -= 1
      render()
      return
    }

    if (button?.matches('[data-fill-next-question]')) {
      if (state.fillCurrentIndex + 1 >= state.fillSessionIndexes.length) return
      state.fillCurrentIndex += 1
      render()
      return
    }

    if (button?.matches('[data-fill-submit]')) {
      if (!state.fillSessionIndexes.length) return
      gradeFillSession()
      openResultNotice('fillBlank')
      return
    }

    if (button?.matches('[data-fill-check]')) {
      const index = state.fillSessionIndexes[state.fillCurrentIndex] ?? state.fillCurrentIndex
      const item = state.database.questions.fillBlank[index]
      if (!item) return
      const isCorrect = normalizeText(state.blankAnswers[index] || '') === normalizeText(item.answer)
      state.fillCheckedMap[index] = isCorrect
      state.fillFeedbackMap[index] = isCorrect
        ? 'Chính xác!'
        : 'Chưa đúng, hãy thử lại.'
      render()
      return
    }

    if (button?.matches('[data-fill-next]')) {
      if (state.fillCurrentIndex + 1 < state.database.questions.fillBlank.length) {
        state.fillCurrentIndex += 1
      } else {
        state.fillCurrentIndex = 0
        state.blankAnswers = Array(state.database.questions.fillBlank.length).fill('')
        state.fillCheckedMap = Array(state.database.questions.fillBlank.length).fill(false)
        state.fillFeedbackMap = Array(state.database.questions.fillBlank.length).fill('')
      }
      render()
      return
    }

    if (button?.matches('[data-writing-start]') || button?.matches('[data-writing-reset-session]')) {
      state.resultNotice = null
      startWritingSession()
      render()
      return
    }

    if (button?.matches('[data-writing-prev]')) {
      if (state.writingCurrentIndex <= 0) return
      state.writingCurrentIndex -= 1
      render()
      return
    }

    if (button?.matches('[data-writing-next-question]')) {
      if (state.writingCurrentIndex + 1 >= state.writingSessionIndexes.length) return
      state.writingCurrentIndex += 1
      render()
      return
    }

    if (button?.matches('[data-writing-submit]')) {
      if (!state.writingSessionIndexes.length) return
      gradeWritingSession()
      openResultNotice('writing')
      return
    }

    if (button?.matches('[data-writing-check]')) {
      const index = state.writingSessionIndexes[state.writingCurrentIndex] ?? state.writingCurrentIndex
      const item = state.database.questions.mcq[index]
      if (!item) return
      const isCorrect = normalizeText(state.writingAnswers[index] || '') === normalizeText(item.answer || '')
      state.writingCheckedMap[index] = isCorrect
      state.writingFeedbackMap[index] = isCorrect
        ? 'Chính xác!'
        : 'Chưa đúng, hãy kiểm tra lại câu trả lời.'
      state.writingScoreDirty = true
      render()
      return
    }

    if (button?.matches('[data-writing-next]')) {
      if (state.writingCurrentIndex + 1 < state.database.questions.mcq.length) {
        state.writingCurrentIndex += 1
      } else {
        state.writingCurrentIndex = 0
        state.writingAnswers = Array(state.database.questions.mcq.length).fill('')
        state.writingCheckedMap = Array(state.database.questions.mcq.length).fill(false)
        state.writingFeedbackMap = Array(state.database.questions.mcq.length).fill('')
        state.writingScoreDirty = true
      }
      render()
      return
    }

    if (button?.matches('[data-arrange-add-token]')) {
      const activeIndex = state.arrangeSessionIndexes[state.arrangeCurrentIndex] ?? 0
      const tokenIndex = Number(button.dataset.arrangeAddToken)
      const selected = state.arrangeSelectedTokenIndexes[activeIndex] || []
      if (!selected.includes(tokenIndex)) selected.push(tokenIndex)
      state.arrangeSelectedTokenIndexes[activeIndex] = selected
      state.arrangeTypedAnswers[activeIndex] = selected
        .map((index) => state.arrangeWordBanks[activeIndex][index])
        .join(' ')
      state.arrangeCheckedMap[activeIndex] = false
      state.arrangeFeedbackMap[activeIndex] = ''
      render()
      return
    }

    if (button?.matches('[data-arrange-remove-token]')) {
      const activeIndex = state.arrangeSessionIndexes[state.arrangeCurrentIndex] ?? 0
      const tokenIndex = Number(button.dataset.arrangeRemoveToken)
      const selected = (state.arrangeSelectedTokenIndexes[activeIndex] || [])
        .filter((index) => index !== tokenIndex)
      state.arrangeSelectedTokenIndexes[activeIndex] = selected
      state.arrangeTypedAnswers[activeIndex] = selected
        .map((index) => state.arrangeWordBanks[activeIndex][index])
        .join(' ')
      state.arrangeCheckedMap[activeIndex] = false
      state.arrangeFeedbackMap[activeIndex] = ''
      render()
      return
    }

    if (button?.matches('[data-arrange-clear-current]')) {
      if (!state.arrangeSessionIndexes.length) return
      const activeIndex = state.arrangeSessionIndexes[state.arrangeCurrentIndex] ?? 0
      state.arrangeTypedAnswers[activeIndex] = ''
      state.arrangeCheckedMap[activeIndex] = false
      state.arrangeShowAnswerMap[activeIndex] = false
      state.arrangeFeedbackMap[activeIndex] = ''
      state.arrangeSelectedTokenIndexes[activeIndex] = []
      render()
      return
    }

    if (button?.matches('[data-arrange-check-current]')) {
      if (!state.arrangeSessionIndexes.length) return
      const activeIndex = state.arrangeSessionIndexes[state.arrangeCurrentIndex] ?? 0
      const currentItem = (state.database.questions.arrange || [])[activeIndex]
      if (!currentItem) return

      const userSentence = normalizeArrangeSentence(state.arrangeTypedAnswers[activeIndex])
      const expectedSentence = normalizeArrangeSentence(currentItem.answer)

      if (!userSentence) {
        state.arrangeFeedbackMap[activeIndex] = 'Bạn chưa nhập câu. Hãy nhập câu đúng rồi kiểm tra lại.'
        state.arrangeCheckedMap[activeIndex] = false
        render()
        return
      }

      if (userSentence === expectedSentence) {
        state.arrangeCheckedMap[activeIndex] = true
        state.arrangeFeedbackMap[activeIndex] = 'Chính xác! Bạn đã nhập đúng hoàn toàn theo ký tự.'
      } else {
        state.arrangeCheckedMap[activeIndex] = false
        state.arrangeFeedbackMap[activeIndex] = 'Chưa đúng. Hãy sắp xếp lại và nhập đúng hoàn toàn theo ký tự.'
      }
      state.arrangeShowAnswerMap[activeIndex] = true

      render()
      return
    }

    if (button?.matches('[data-arrange-show-answer]')) {
      if (!state.arrangeSessionIndexes.length) return
      const activeIndex = state.arrangeSessionIndexes[state.arrangeCurrentIndex] ?? 0
      state.arrangeShowAnswerMap[activeIndex] = !state.arrangeShowAnswerMap[activeIndex]
      render()
      return
    }

    if (button?.matches('[data-arrange-prev]')) {
      if (state.arrangeCurrentIndex <= 0) return
      state.arrangeCurrentIndex -= 1
      render()
      return
    }

    if (button?.matches('[data-arrange-submit]')) {
      if (!state.arrangeSessionIndexes.length) return
      gradeArrangeSession()
      openResultNotice('arrange')
      return
    }

    if (button?.matches('[data-arrange-skip-question]')) {
      const uncheckedIndexes = state.arrangeSessionIndexes
        .filter((index) => !state.arrangeCheckedMap[index])
        .filter((index) => index !== state.arrangeSessionIndexes[state.arrangeCurrentIndex])

      if (!uncheckedIndexes.length) return

      const prevIndex = state.arrangeSessionIndexes[state.arrangeCurrentIndex] ?? 0
      const randomIndex = Math.floor(Math.random() * uncheckedIndexes.length)
      const nextQuestionIndex = uncheckedIndexes[randomIndex]
      state.arrangeCurrentIndex = state.arrangeSessionIndexes.findIndex((index) => index === nextQuestionIndex)
      state.arrangeShowAnswerMap[prevIndex] = false
      render()
      return
    }

    if (button?.matches('[data-arrange-next-question]')) {
      if (state.arrangeSessionPhase === 'playing' || state.arrangeSessionPhase === 'completed') {
        if (state.arrangeCurrentIndex + 1 >= state.arrangeSessionIndexes.length) return
        state.arrangeCurrentIndex += 1
        render()
        return
      }

      const uncheckedIndexes = state.arrangeSessionIndexes
        .filter((index) => !state.arrangeCheckedMap[index])

      if (!uncheckedIndexes.length) {
        resetArrangeSession((state.database.questions.arrange || []).length)
        render()
        return
      }

      const randomIndex = Math.floor(Math.random() * uncheckedIndexes.length)
      const nextQuestionIndex = uncheckedIndexes[randomIndex]
      const prevIndex = state.arrangeSessionIndexes[state.arrangeCurrentIndex] ?? 0
      state.arrangeCurrentIndex = state.arrangeSessionIndexes.findIndex((index) => index === nextQuestionIndex)
      state.arrangeShowAnswerMap[prevIndex] = false
      render()
      return
    }

    if (button?.matches('[data-arrange-reset-session]')) {
      resetArrangeSession((state.database.questions.arrange || []).length)
      render()
      return
    }

    if (button?.matches('[data-edit-vocab]')) {
      const id = normalizeEntityId(button.dataset.editVocab)
      const item = state.database.vocabulary.find((entry) => idsEqual(entry.id, id))
      if (!item) return

      openEditDialog({
        kind: 'vocab',
        id,
        word: item.word,
        definition: item.definition,
        example: item.example || '',
        wordType: item.wordType || 'other',
      })
      return
    }

    if (button?.matches('[data-edit-source-matching]')) {
      const id = normalizeEntityId(button.dataset.editSourceMatching)
      const item = (state.database.questions.matching || []).find((entry) => idsEqual(entry.id, id))
      if (!item) return

      openEditDialog({
        kind: 'matching',
        id,
        word: item.word,
        meaning: item.meaning,
      })
      return
    }

    if (button?.matches('[data-edit-question-answer]')) {
      const id = normalizeEntityId(button.dataset.editQuestionAnswer)
      const item = (state.database.questions.mcq || []).find((entry) => idsEqual(entry.id, id))
      if (!item) return

      openEditDialog({
        kind: 'mcq',
        id,
        question: item.question,
        answer: item.answer,
      })
      return
    }

    if (button?.matches('[data-edit-question]')) {
      const token = String(button.dataset.editQuestion || '')
      const [questionType, rawId] = token.split(':')
      const id = normalizeEntityId(rawId)
      if (!questionType || !id) return

      if (questionType === 'mcq') {
        const item = (state.database.questions.mcq || []).find((entry) => idsEqual(entry.id, id))
        if (!item) return
        openEditDialog({
          kind: 'mcq',
          id,
          question: item.question,
          answer: item.answer,
        })
        return
      }

      if (questionType === 'matching') {
        const item = (state.database.questions.matching || []).find((entry) => idsEqual(entry.id, id))
        if (!item) return
        openEditDialog({
          kind: 'matching',
          id,
          word: item.word,
          meaning: item.meaning,
        })
        return
      }

      if (questionType === 'fillBlank') {
        const item = (state.database.questions.fillBlank || []).find((entry) => idsEqual(entry.id, id))
        if (!item) return
        openEditDialog({
          kind: 'fillBlank',
          id,
          sentence: item.sentence,
          answer: item.answer,
        })
        return
      }

      if (questionType === 'writing' || questionType === 'listing' || questionType === 'arrange') {
        const sourceList = questionType === 'writing'
          ? (state.database.questions.writing || [])
          : questionType === 'listing'
            ? (state.database.questions.listing || [])
            : (state.database.questions.arrange || [])
        const item = sourceList.find((entry) => idsEqual(entry.id, id))
        if (!item) return

        openEditDialog({
          kind: questionType,
          id,
          questionType,
          ...(questionType === 'writing'
            ? {
              word: item.word,
              hint: item.hint || '',
              keywords: item.keywords || [],
            }
            : {
              prompt: item.prompt,
              hint: item.hint || '',
              answers: item.answers || [],
            }),
          ...(questionType === 'arrange'
            ? {
              prompt: item.prompt,
              hint: item.hint || '',
              answer: item.answer || '',
            }
            : {}),
        })
      }
      return
    }

    if (button?.matches('[data-edit-shared-list-question]')) {
      const token = String(button.dataset.editSharedListQuestion || '')
      const [questionType, rawId] = token.split(':')
      const id = normalizeEntityId(rawId)
      if (!questionType || !id) return

      const sourceList = questionType === 'writing'
        ? (state.database.questions.writing || [])
        : (state.database.questions.listing || [])
      const item = sourceList.find((entry) => idsEqual(entry.id, id))
      if (!item) return

      openEditDialog({
        kind: questionType,
        id,
        questionType,
        ...(questionType === 'writing'
          ? {
            word: item.word,
            hint: item.hint || '',
            keywords: item.keywords || [],
          }
          : {
            prompt: item.prompt,
            hint: item.hint || '',
            answers: item.answers || [],
          }),
      })
      return
    }

    if (button?.matches('[data-edit-arrange-question]')) {
      const id = normalizeEntityId(button.dataset.editArrangeQuestion)
      const item = (state.database.questions.arrange || []).find((entry) => idsEqual(entry.id, id))
      if (!item) return

      openEditDialog({
        kind: 'arrange',
        id,
        prompt: item.prompt,
        hint: item.hint || '',
        answer: item.answer || '',
      })
      return
    }

    if (button?.matches('[data-matching-reset-session]')) {
      startMatchingSession()
      render()
      return
    }

    if (button?.matches('[data-matching-start]')) {
      startMatchingSession()
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
      state.matchingSelectedLeftId = selectedLeftId

      render()
      return
    }

    if (button?.matches('[data-matching-check-result]')) {
      if (!isMatchingRoundComplete()) return
      state.matchingChecked = true
      state.matchingShowAnswer = true
      openResultNotice('matching')
      return
    }

    if (button?.matches('[data-matching-show-answer]')) {
      state.matchingShowAnswer = !state.matchingShowAnswer
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

    if (button?.matches('[data-mcq-show-current-answer]')) {
      if (!state.mcqQuizQuestions.length) return
      state.mcqShowAnswerMap[state.mcqCurrentIndex] = !state.mcqShowAnswerMap[state.mcqCurrentIndex]
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

    const closeEditTarget = target.closest('[data-close-edit-dialog]')
    if (closeEditTarget) {
      if (
        closeEditTarget.classList.contains('edit-overlay')
        && event.target !== closeEditTarget
      ) {
        return
      }
      closeEditDialog()
    }
  })
}

function parseQuestionPayload(formData) {
  const type = String(formData.get('type') || 'mcq').trim()
  const question = String(formData.get('question') || '').trim()
  const answer = String(formData.get('answer') || '').trim()

  if (type === 'fillBlank') {
    return {
      type: 'fillBlank',
      sentence: question,
      answer,
    }
  }

  return {
    type: 'mcq',
    mode: 'general',
    question,
    answer,
  }
}

function attachEvents() {
  attachExerciseEvents()
}

function render() {
  state.route = getRoute()
  let nextMarkup = ''

  if (state.loading) {
    nextMarkup = '<main class="shell"><section class="content"><p>Đang tải dữ liệu...</p></section></main>'
  } else if (state.serverError) {
    nextMarkup = `<main class="shell"><section class="content"><p>Không truy vấn được dữ liệu: ${escapeHtml(state.serverError)}</p></section></main>`
  } else {
    nextMarkup = renderCurrentPage()
  }

  if (nextMarkup === lastRenderedMarkup) {
    scheduleMatchingLinesRender()
    return
  }

  app.innerHTML = nextMarkup
  lastRenderedMarkup = nextMarkup
  attachEvents()
  scheduleMatchingLinesRender()
}

window.addEventListener('resize', () => {
  if (state.route !== '/exercise/matching' || state.matchingSessionPhase !== 'playing') return
  scheduleMatchingLinesRender()
})

window.addEventListener('hashchange', async () => {
  state.sourceMessage = ''
  state.resultNotice = null
  await loadDataForCurrentRoute()
})

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !state.slideBoardOpen) return
  state.slideBoardOpen = false
  render()
})

async function bootstrap() {
  if (!window.location.hash) {
    setRoute('/welcome')
    await loadDataForCurrentRoute()
    return
  }

  await loadDataForCurrentRoute()
}

bootstrap()
