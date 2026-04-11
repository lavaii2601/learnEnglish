import './style.css'
import {
  createQuestion,
  createVocabulary,
  deleteVocabulary,
  fetchDatabase,
  updateVocabulary,
} from './api'

const app = document.querySelector('#app')
const SIDEBAR_OPEN_STORAGE_KEY = 'english_lab_sidebar_open'
const DATABASE_CACHE_TTL_MS = 30_000

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
    questions: { mcq: [], matching: [], fillBlank: [], writing: [] },
  },
  mcqAnswers: [],
  matchAnswers: {},
  blankAnswers: [],
  writingAnswers: [],
  slideBoardOpen: false,
  sidebarOpen: loadSidebarOpenState(),
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
  mcqCurrentIndex: 0,
  mcqNextPromptOpen: false,
  mcqReviewOpen: false,
  mcqWrongQuestions: [],
  databaseCache: {},
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
  return hash.replace('#', '')
}

function setRoute(route) {
  window.location.hash = `#${route}`
}

function buildFallbackOptions(correctAnswer, pool) {
  const uniquePool = [...new Set(pool.filter((item) => item && item !== correctAnswer))]
  const distractors = getShuffledItems(uniquePool).slice(0, 3)
  while (distractors.length < 3) {
    distractors.push(`Phương án nhiễu ${distractors.length + 1}`)
  }
  return getShuffledItems([correctAnswer, ...distractors])
}

function getClientFallbackMcqItems() {
  const vocabItems = state.database.vocabulary
    .filter((item) => String(item.definition || '').trim())
    .map((item) => ({
      id: `fallback-vocab-${item.id}`,
      question: `Nghĩa của từ "${item.word}" là gì?`,
      answer: String(item.definition || '').trim(),
      source: 'vocabulary',
    }))

  const questionItems = (state.database.questions.mcq || [])
    .filter((item) => String(item.answer || '').trim())
    .map((item) => ({
      id: `fallback-question-${item.id}`,
      question: item.question,
      answer: item.answer,
      source: 'question',
    }))

  let selectedItems = []
  if (state.mcqSourceMode === 'vocabulary') selectedItems = vocabItems
  if (state.mcqSourceMode === 'question') selectedItems = questionItems
  if (state.mcqSourceMode === 'mix') selectedItems = [...questionItems, ...vocabItems]

  const answerPool = selectedItems.map((item) => item.answer)

  return getShuffledItems(selectedItems).map((item) => ({
    id: item.id,
    question: item.question,
    answer: item.answer,
    options: buildFallbackOptions(item.answer, answerPool),
  }))
}

function getMcqExerciseItems() {
  if (Array.isArray(state.database.questions.mcqExercise)) {
    return state.database.questions.mcqExercise
  }
  return getClientFallbackMcqItems()
}

function prepareMcqPool() {
  state.mcqPoolQuestions = getMcqExerciseItems()
}

function getShuffledItems(items) {
  const list = [...items]
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[list[index], list[swapIndex]] = [list[swapIndex], list[index]]
  }
  return list
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

function startMcqQuizRound(useWrongOnly = false) {
  const source = useWrongOnly && state.mcqWrongQuestions?.length
    ? state.mcqWrongQuestions
    : state.mcqPoolQuestions
  const pool = Array.isArray(source) ? source : []
  const maxCount = Math.min(state.mcqQuestionCount || 5, pool.length)
  const quizItems = state.mcqSourceMode === 'mix'
    ? pickMixedQuizItems(pool, maxCount)
    : getShuffledItems(pool).slice(0, maxCount)

  state.mcqQuizQuestions = quizItems
  state.mcqAnswers = Array(quizItems.length).fill('')
  state.mcqCurrentIndex = 0
  state.mcqNextPromptOpen = false
  state.mcqReviewOpen = false
  state.mcqSessionPhase = 'playing'
  state.mcqWrongQuestions = []
}

function resetExerciseState() {
  const { matching, fillBlank, writing } = state.database.questions
  prepareMcqPool()
  state.mcqQuizQuestions = []
  state.mcqAnswers = []
  state.mcqCurrentIndex = 0
  state.mcqNextPromptOpen = false
  state.mcqReviewOpen = false
  state.mcqSessionPhase = 'setup'
  state.mcqWrongQuestions = []
  state.matchAnswers = Object.fromEntries(matching.map((item) => [item.id, '']))
  state.blankAnswers = Array(fillBlank.length).fill('')
  state.writingAnswers = Array(writing.length).fill('')
}

function scoreMcq() {
  let score = 0
  state.mcqQuizQuestions.forEach((item, index) => {
    if (state.mcqAnswers[index] === item.answer) score += 1
  })
  return score
}

function scoreMatching() {
  let score = 0
  state.database.questions.matching.forEach((item) => {
    if (state.matchAnswers[item.id] === item.meaning) score += 1
  })
  return score
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
  return state.database.questions.writing.map((item, index) => {
    const userText = normalizeText(state.writingAnswers[index] || '')
    const hitCount = item.keywords.filter((keyword) => userText.includes(keyword)).length
    const percent = item.keywords.length
      ? Math.round((hitCount / item.keywords.length) * 100)
      : 0

    return {
      hitCount,
      total: item.keywords.length,
      percent,
    }
  })
}

function getWritingCorrectCount() {
  const scores = scoreWriting()
  return scores.filter((item) => item.percent >= 60).length
}

function isMcqRoundComplete() {
  if (!state.mcqQuizQuestions.length) return false
  return state.mcqAnswers.every((answer) => String(answer || '').trim().length > 0)
}

function finishMcqSession() {
  state.mcqWrongQuestions = state.mcqQuizQuestions.filter((item, index) => state.mcqAnswers[index] !== item.answer)
  state.mcqSessionPhase = 'completed'
  state.mcqReviewOpen = true
}

function openResultNotice(type) {
  if (type === 'mcq' && !isMcqRoundComplete()) {
    state.resultNotice = {
      type,
      title: 'Chưa hoàn thành bài trắc nghiệm',
      message: 'Vui lòng trả lời đủ 5 câu trước khi kiểm tra kết quả.',
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
    total = state.database.questions.matching.length
    title = 'Kết quả nối từ'
  }

  if (type === 'fillBlank') {
    correct = scoreBlanks()
    total = state.database.questions.fillBlank.length
    title = 'Kết quả điền chỗ trống'
  }

  if (type === 'writing') {
    correct = getWritingCorrectCount()
    total = state.database.questions.writing.length
    title = 'Kết quả viết định nghĩa'
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
    '/source': 'Thêm nguồn',
    '/source/vocab': 'Thêm từ vựng',
    '/source/questions': 'Thêm câu hỏi',
  }

  const questionAnswerCount = state.database.questions.mcq.length
  const vocabularyCount = state.database.vocabulary.length
  const mcqTotalCount = vocabularyCount + questionAnswerCount
  const totalQuestions =
    questionAnswerCount +
    state.database.questions.matching.length +
    state.database.questions.fillBlank.length +
    state.database.questions.writing.length

  return `
    <main class="shell app-shell ${state.sidebarOpen ? '' : 'menu-hidden'}">
      <aside class="sidebar">
        <h1>learnEnglish</h1>
        <p class="muted">Luyện tập và quản lý dữ liệu học tiếng Anh.</p>

        <p class="group-title">Điều hướng</p>
        <button class="nav-btn ${state.route === '/home' ? 'active' : ''}" data-route="/home">Trang chủ</button>

        <p class="group-title">Bài tập</p>
        <button class="nav-btn ${state.route === '/exercise/mcq' ? 'active' : ''}" data-route="/exercise/mcq">Trắc nghiệm</button>
        <button class="nav-btn ${state.route === '/exercise/matching' ? 'active' : ''}" data-route="/exercise/matching">Nối từ</button>
        <button class="nav-btn ${state.route === '/exercise/fill' ? 'active' : ''}" data-route="/exercise/fill">Điền chỗ trống</button>
        <button class="nav-btn ${state.route === '/exercise/writing' ? 'active' : ''}" data-route="/exercise/writing">Viết</button>

        <p class="group-title">Nguồn dữ liệu</p>
        <button class="nav-btn ${state.route === '/source' ? 'active' : ''}" data-route="/source">Trang thêm nguồn</button>
        <button class="nav-btn ${state.route === '/source/vocab' ? 'active' : ''}" data-route="/source/vocab">Nhiệm vụ: Thêm từ vựng</button>
        <button class="nav-btn ${state.route === '/source/questions' ? 'active' : ''}" data-route="/source/questions">Nhiệm vụ: Thêm câu hỏi + trả lời</button>

        <button
          class="slide-trigger ${state.slideBoardOpen ? 'active' : ''}"
          data-toggle-slide-board="true"
          type="button"
          aria-expanded="${state.slideBoardOpen ? 'true' : 'false'}"
        >
          ${state.slideBoardOpen ? 'Thu gọn bảng nhanh' : 'Mở bảng nhanh'}
        </button>

        <section class="slide-board ${state.slideBoardOpen ? 'open' : ''}" aria-hidden="${state.slideBoardOpen ? 'false' : 'true'}">
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
          </div>
        </section>
      </aside>

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
            <p class="route-pill">${routeTitleMap[state.route] || 'learnEnglish'}</p>
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
              ${state.resultNotice.type === 'mcq' ? '<button type="button" class="small-btn" data-retry-mcq>Làm bộ 5 câu mới</button>' : ''}
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
        <p class="landing-eyebrow">learnEnglish</p>
        <h1>Luyện tiếng Anh theo cách đơn giản</h1>
        <p class="landing-subtitle">Bắt đầu nhanh với bộ bài tập và trang quản lý dữ liệu học tập.</p>
        <div class="landing-actions">
          <button type="button" class="action-btn" data-route="/exercise/mcq">Vào luyện tập</button>
          <button type="button" class="small-btn" data-route="/source">Quản lý nguồn dữ liệu</button>
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
    payload = await fetchDatabase({ mcqMode: state.mcqSourceMode })
  } else {
    payload = await fetchDatabase()
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

  return `
    <section class="page-card">
      <h2>learnEnglish</h2>
      <p>Chọn tính năng ở menu bên trái. Mỗi bài tập sẽ được chấm dựa trên dữ liệu đang lưu trong cơ sở dữ liệu.</p>
      <div class="stat-grid">
        <article><strong>${vocabCount}</strong><span>Từ vựng</span></article>
        <article><strong>${mcqCount}</strong><span>Câu trắc nghiệm</span></article>
        <article><strong>${matchingCount}</strong><span>Cặp nối từ</span></article>
        <article><strong>${blankCount}</strong><span>Câu điền trống</span></article>
        <article><strong>${writingCount}</strong><span>Đề viết</span></article>
      </div>
    </section>
  `
}

function renderMcqPage() {
  const questions = state.mcqQuizQuestions
  const score = scoreMcq()
  const availableCount = state.mcqPoolQuestions.length
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
      </section>
      ${state.mcqNextPromptOpen
        ? `
          <article class="question-card next-question-board">
            <h3>${state.mcqCurrentIndex + 1 < questions.length ? 'Đã lưu câu trả lời.' : 'Bạn đã hoàn thành bộ câu hỏi.'}</h3>
            <p>${state.mcqCurrentIndex + 1 < questions.length ? 'Bấm để qua câu kế tiếp.' : 'Bấm để xem kết quả.'}</p>
            <button type="button" class="action-btn" data-mcq-next>
              ${state.mcqCurrentIndex + 1 < questions.length ? 'Qua câu kế tiếp' : 'Xem kết quả'}
            </button>
          </article>
        `
        : ''}
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
      ${inPlay ? `<p class="score-line">Điểm tạm thời: <strong>${score}/${questions.length}</strong></p>` : ''}
      ${inPlay ? `<button type="button" class="small-btn" data-mcq-retry>Kiểm tra lại (random bộ mới)</button>` : ''}
    </section>
  `
}

function renderMatchingPage() {
  const items = state.database.questions.matching
  const score = scoreMatching()
  const meanings = [...items].map((item) => item.meaning).sort(() => Math.random() - 0.5)

  return `
    <section class="page-card">
      <h2>Nối từ</h2>
      ${items
        .map(
          (item) => `
            <article class="question-card compact">
              <h3 class="question-title">
                <span class="question-order">Chọn nghĩa phù hợp</span>
                <span class="question-text">${escapeHtml(item.word)}</span>
              </h3>
              <select data-match-id="${item.id}">
                <option value="">-- Chọn nghĩa --</option>
                ${meanings
                  .map(
                    (meaning) => `
                      <option value="${escapeHtml(meaning)}" ${state.matchAnswers[item.id] === meaning ? 'selected' : ''}>
                        ${escapeHtml(meaning)}
                      </option>
                    `,
                  )
                  .join('')}
              </select>
            </article>
          `,
        )
        .join('')}
      <p class="score-line">Điểm: <strong>${score}/${items.length}</strong></p>
      <button type="button" class="action-btn" data-check-result="matching">Kiểm tra kết quả</button>
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
  const correctCount = getWritingCorrectCount()

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
              <textarea data-writing-index="${index}" rows="4" placeholder="Viết định nghĩa của bạn...">${escapeHtml(state.writingAnswers[index] || '')}</textarea>
              <p class="muted">Độ khớp từ khóa: <strong>${scores[index].percent}%</strong> (${scores[index].hitCount}/${scores[index].total})</p>
            </article>
          `,
        )
        .join('')}
      <p class="score-line">Câu đạt yêu cầu (>= 60%): <strong>${correctCount}/${items.length}</strong></p>
      <button type="button" class="action-btn" data-check-result="writing">Kiểm tra kết quả</button>
    </section>
  `
}

function renderSourceHome() {
  return `
    <section class="page-card">
      <h2>Thêm nguồn</h2>
      <p>Bạn có 2 nhiệm vụ riêng:</p>
      <div class="action-grid">
        <button class="action-btn" data-route="/source/vocab">Nhiệm vụ 1: Thêm từ vựng</button>
        <button class="action-btn" data-route="/source/questions">Nhiệm vụ 2: Thêm câu hỏi + câu trả lời</button>
      </div>
      <h3>Từ vựng gần đây</h3>
      <ul class="list-view">
        ${state.database.vocabulary
          .slice(0, 6)
          .map((item) => `<li><strong>${escapeHtml(item.word)}:</strong> ${escapeHtml(item.definition)}</li>`)
          .join('')}
      </ul>
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
            <p class="muted">Từ khóa: ${escapeHtml(item.keywords.join(', '))}</p>
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
  return `
    <section class="page-card">
      <h2>Nhiệm vụ: Thêm câu hỏi + câu trả lời</h2>
      <form id="question-form" class="stack-form">
        <p class="muted">Nhập câu hỏi và đáp án để lưu vào cơ sở dữ liệu câu hỏi.</p>
        <label>Câu hỏi<input name="question" required placeholder="Ví dụ: Nghĩa của từ resilient là gì?" /></label>
        <label>Đáp án đúng<input name="answer" required placeholder="Có khả năng phục hồi nhanh sau khó khăn" /></label>
        <button type="submit">Lưu câu hỏi vào cơ sở dữ liệu</button>
      </form>
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
  if (state.route === '/source') return renderLayout(renderSourceHome())
  if (state.route === '/source/vocab') return renderLayout(renderSourceVocab())
  if (state.route === '/source/questions') return renderLayout(renderSourceQuestion())
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
      state.slideBoardOpen = !state.slideBoardOpen
      render()
    })
  })

  document.querySelectorAll('[data-toggle-menu]').forEach((button) => {
    button.addEventListener('click', () => {
      state.sidebarOpen = !state.sidebarOpen
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(state.sidebarOpen))
      if (!state.sidebarOpen) {
        state.slideBoardOpen = false
      }
      render()
    })
  })
}

function attachExerciseEvents() {
  document.querySelectorAll('input[type="radio"]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const target = event.target
      if (state.mcqReviewOpen || state.mcqSessionPhase !== 'playing') return

      if (target.name !== 'mcq-current') {
        const index = Number(target.name.split('-')[1])
        state.mcqAnswers[index] = target.value
        render()
        return
      }

      state.mcqAnswers[state.mcqCurrentIndex] = target.value
      state.mcqNextPromptOpen = true
      render()
    })
  })

  document.querySelectorAll('[data-mcq-next]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.mcqCurrentIndex + 1 < state.mcqQuizQuestions.length) {
        state.mcqCurrentIndex += 1
        state.mcqNextPromptOpen = false
        render()
        return
      }

      state.mcqNextPromptOpen = false
      finishMcqSession()
      openResultNotice('mcq')
    })
  })

  document.querySelectorAll('select[data-match-id]').forEach((select) => {
    select.addEventListener('change', (event) => {
      const target = event.target
      state.matchAnswers[target.dataset.matchId] = target.value
      render()
    })
  })

  document.querySelectorAll('input[data-blank-index]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const target = event.target
      state.blankAnswers[Number(target.dataset.blankIndex)] = target.value
      render()
    })
  })

  document.querySelectorAll('textarea[data-writing-index]').forEach((textarea) => {
    textarea.addEventListener('input', (event) => {
      const target = event.target
      state.writingAnswers[Number(target.dataset.writingIndex)] = target.value
      render()
    })
  })

  document.querySelectorAll('[data-mcq-source-mode]').forEach((select) => {
    select.addEventListener('change', async (event) => {
      const target = event.target
      state.mcqSourceMode = target.value
      await loadDataForCurrentRoute()
    })
  })

  document.querySelectorAll('[data-mcq-question-count]').forEach((select) => {
    select.addEventListener('change', (event) => {
      const target = event.target
      state.mcqQuestionCount = Number(target.value) || 5
      render()
    })
  })

  document.querySelectorAll('[data-mcq-start]').forEach((button) => {
    button.addEventListener('click', () => {
      startMcqQuizRound(false)
      render()
    })
  })

  document.querySelectorAll('[data-mcq-retry-wrong]').forEach((button) => {
    button.addEventListener('click', () => {
      startMcqQuizRound(true)
      render()
    })
  })

  document.querySelectorAll('[data-check-result]').forEach((button) => {
    button.addEventListener('click', () => {
      const type = button.dataset.checkResult
      if (!type) return
      if (type === 'mcq' && !isMcqRoundComplete()) {
        openResultNotice('mcq')
        return
      }
      openResultNotice(type)
    })
  })

  document.querySelectorAll('[data-mcq-retry]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.resultNotice = null
      if (state.mcqSessionPhase === 'completed' && state.mcqWrongQuestions.length) {
        startMcqQuizRound(true)
        render()
        return
      }
      await loadDataForCurrentRoute()
    })
  })

  document.querySelectorAll('[data-open-mcq-review]').forEach((button) => {
    button.addEventListener('click', () => {
      state.resultNotice = null
      state.mcqReviewOpen = true
      render()
    })
  })

  document.querySelectorAll('[data-close-mcq-review]').forEach((button) => {
    button.addEventListener('click', () => {
      state.mcqReviewOpen = false
      render()
    })
  })

  document.querySelectorAll('[data-retry-mcq]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.resultNotice = null
      await loadDataForCurrentRoute()
    })
  })

  document.querySelectorAll('[data-close-result]').forEach((element) => {
    element.addEventListener('click', (event) => {
      if (
        element.classList.contains('result-overlay') &&
        event.target !== event.currentTarget
      ) {
        return
      }
      state.resultNotice = null
      render()
    })
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
