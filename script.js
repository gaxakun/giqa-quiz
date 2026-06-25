/* ════════════════════════════════════════════════
   SUBJECTS — metadata loaded from data/subjects.json
   Question banks are fetched on demand per subject
   (data/<subject-id>.json), keeping each bank modular
   and independently editable without touching app logic.
════════════════════════════════════════════════ */
let subjectsList = []; // populated by loadSubjects()
let currentSubject = null; // the subject object the user picked

async function loadSubjects() {
  const res = await fetch("data/subjects.json");
  if (!res.ok) throw new Error("Failed to load subjects.json");
  subjectsList = await res.json();
  return subjectsList;
}

async function loadQuestionBank(subject) {
  const res = await fetch(subject.file);
  if (!res.ok) throw new Error(`Failed to load question bank: ${subject.file}`);
  return res.json();
}

/* ════════════════════════════════════════════════
   CONSTANTS & STATE
════════════════════════════════════════════════ */
const STORAGE_KEY = "giqaState";
const HISTORY_KEY = "giqaHistory"; // localStorage key for completed-attempt history
const BASE_POINTS = 10;
const STREAK_BONUS = 5;
const LETTERS = ["A", "B", "C", "D"];

let quizData = []; // active subject's full question bank (replaces old hardcoded const)
let questions = []; // shuffled question list for current session
let state = {}; // { currentIndex, totalScore, currentStreak, highStreak, answers, completed }
let answered = false;
let selectedIdx = null;
let endTime = 0;
let timerInterval = null;
let quizDurationMs = 40 * 60 * 1000; // default 40 min; overridden per-subject from subjects.json

/* ════════════════════════════════════════════════
   DOM REFERENCES
════════════════════════════════════════════════ */
const screens = {
  home: document.getElementById("screen-home"),
  subjects: document.getElementById("screen-subjects"),
  quiz: document.getElementById("screen-quiz"),
  results: document.getElementById("screen-results"),
  review: document.getElementById("screen-review"),
  history: document.getElementById("screen-history"),
};
const badgeScore = document.getElementById("badge-score");
const badgeStreak = document.getElementById("badge-streak");
const badgeStreakW = document.getElementById("badge-streak-wrap");
const badgeTimer = document.getElementById("badge-timer");
const timerText = document.getElementById("timer-text");
const qCounter = document.getElementById("q-counter");
const progFill = document.getElementById("prog-fill");
const qLabel = document.getElementById("q-label");
const qText = document.getElementById("q-text");
const qCard = document.getElementById("question-card");
const optionsGrid = document.getElementById("options-grid");
const explanBox = document.getElementById("explanation-box");
const explanResult = document.getElementById("explanation-result");
const explanText = document.getElementById("explanation-text");
const navRow = document.getElementById("nav-row");
const btnNext = document.getElementById("btn-next");
const srStatus = document.getElementById("sr-status");
const streakPopup = document.getElementById("streak-popup");
const streakPopupT = document.getElementById("streak-popup-text");

/* ════════════════════════════════════════════════
   UTILITY FUNCTIONS
════════════════════════════════════════════════ */

// Fisher-Yates shuffle — O(n), unbiased
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    el.classList.toggle("active", k === name);
  });
}

/* ════════════════════════════════════════════════
   LOCAL STORAGE
════════════════════════════════════════════════ */
function saveProgress() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...state,
        endTime,
        subjectId: currentSubject ? currentSubject.id : null,
      }),
    );
  } catch (e) {}
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.completed || !s.endTime || Date.now() > s.endTime) return null;
    return s;
  } catch (e) {
    return null;
  }
}

function clearProgress() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {}
}

/* ════════════════════════════════════════════════
   TIMER
════════════════════════════════════════════════ */
function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    const remaining = endTime - Date.now();
    if (remaining <= 5000) {
      badgeTimer.classList.add("urgent", "anim-timer-urgent");
    }
    if (remaining <= 0) {
      stopTimer();
      endQuiz("timeout");
      return;
    }
    timerText.textContent = formatTime(remaining);
  }, 200);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// PRD Alignment: clearInterval on beforeunload
window.addEventListener("beforeunload", () => clearInterval(timerInterval));

/* ════════════════════════════════════════════════
   PREPARE QUESTIONS
════════════════════════════════════════════════ */
function prepareQuestions() {
  const count = currentSubject ? currentSubject.questionCount : 20;
  return shuffleArray(quizData)
    .slice(0, count)
    .map((q) => {
      const indexed = q.options.map((opt, i) => ({ opt, i }));
      const shuffled = shuffleArray(indexed);
      return {
        ...q,
        shuffledOptions: shuffled.map((s) => s.opt),
        originalIndices: shuffled.map((s) => s.i),
      };
    });
}

/* ════════════════════════════════════════════════
   RENDER QUESTION
════════════════════════════════════════════════ */
function renderQuestion() {
  const q = questions[state.currentIndex];
  const total = questions.length;

  answered = false;
  selectedIdx = null;

  // Progress
  const pct = Math.round((state.currentIndex / total) * 100);
  progFill.style.width = pct + "%";
  progFill.setAttribute("aria-valuenow", pct); // ARIA update

  // Counter
  qCounter.textContent = `${state.currentIndex + 1} / ${total}`;

  // Question text — animate entry
  qCard.classList.remove("anim-q-enter");
  void qCard.offsetWidth; // reflow trigger
  qCard.classList.add("anim-q-enter");
  qLabel.textContent = `Question ${state.currentIndex + 1}`;
  qText.textContent = q.question;

  // Build options — event delegation handles clicks
  optionsGrid.innerHTML = "";
  q.shuffledOptions.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.className = `opt-btn anim-opt-${i} samo-opt-delegated`;
    btn.dataset.index = i;
    btn.setAttribute("data-testid", `option-btn-${i}`);
    btn.innerHTML = `<span class="opt-letter">${LETTERS[i]}</span><span>${opt}</span>`;
    optionsGrid.appendChild(btn);
  });

  // Hide explanation & next button
  explanBox.classList.remove("visible");
  navRow.style.display = "none";
}

/* ════════════════════════════════════════════════
   EVENT DELEGATION — single listener on optionsGrid
   (PRD Alignment requirement)
════════════════════════════════════════════════ */
optionsGrid.addEventListener("click", function (e) {
  const btn = e.target.closest(".samo-opt-delegated");
  if (!btn || btn.disabled || answered) return;
  const idx = parseInt(btn.dataset.index, 10);
  selectAnswer(idx);
});

/* ════════════════════════════════════════════════
   SELECT ANSWER
════════════════════════════════════════════════ */
function selectAnswer(shuffledIndex) {
  if (answered) return;
  answered = true;
  selectedIdx = shuffledIndex;

  const q = questions[state.currentIndex];
  const origIdx = q.originalIndices[shuffledIndex];
  const isCorrect = origIdx === q.correctIndex;

  // Disable all buttons
  optionsGrid
    .querySelectorAll(".samo-opt-delegated")
    .forEach((b) => (b.disabled = true));

  // Style buttons
  optionsGrid.querySelectorAll(".samo-opt-delegated").forEach((btn, i) => {
    const bOrig = q.originalIndices[i];
    const isCorrectOpt = bOrig === q.correctIndex;

    if (i === shuffledIndex) {
      btn.classList.add(isCorrectOpt ? "correct" : "wrong");
      btn.classList.add(isCorrectOpt ? "anim-correct" : "anim-wrong");
    } else if (isCorrectOpt) {
      btn.classList.add("reveal");
    }
  });

  // Update score & streak with requestAnimationFrame (PRD Alignment)
  const newStreak = isCorrect ? state.currentStreak + 1 : 0;
  const bonus = isCorrect ? BASE_POINTS + newStreak * STREAK_BONUS : 0;

  state.totalScore += bonus;
  state.currentStreak = newStreak;
  state.highStreak = Math.max(state.highStreak, newStreak);
  state.answers.push({ questionId: q.id, shuffledIndex, origIdx, isCorrect });

  requestAnimationFrame(() => {
    badgeScore.textContent = state.totalScore;
    badgeStreak.textContent = state.currentStreak;

    if (state.currentStreak >= 3) {
      badgeStreakW.classList.add("hot");
      badgeStreakW.classList.remove("anim-streak-pop");
      void badgeStreakW.offsetWidth;
      badgeStreakW.classList.add("anim-streak-pop");
    } else {
      badgeStreakW.classList.remove("hot");
    }
  });

  // Streak popup
  if (isCorrect && state.currentStreak >= 3) {
    streakPopupT.textContent = `${state.currentStreak} STREAK!`;
    streakPopup.classList.add("visible", "anim-popup-in");
    setTimeout(
      () => streakPopup.classList.remove("visible", "anim-popup-in"),
      1600,
    );
  }

  // Explanation
  const correctOptText =
    q.shuffledOptions[
      q.shuffledOptions.findIndex(
        (_, i) => q.originalIndices[i] === q.correctIndex,
      )
    ];
  explanResult.textContent = isCorrect
    ? `Correct! +${bonus} pts`
    : `Incorrect — correct answer: "${correctOptText}"`;
  explanResult.className =
    "explanation-result " + (isCorrect ? "correct-text" : "wrong-text");
  explanText.textContent = q.explanation;
  explanBox.classList.add("visible");

  // Screen reader
  srStatus.textContent = isCorrect
    ? `Correct! You earned ${bonus} points. Streak: ${state.currentStreak}.`
    : "Incorrect answer.";

  // Next button label
  btnNext.innerHTML =
    state.currentIndex + 1 >= questions.length
      ? 'See Results <span aria-hidden="true">›</span>'
      : 'Next Question <span aria-hidden="true">›</span>';
  navRow.style.display = "flex";

  // Save progress
  saveProgress();
}

/* ════════════════════════════════════════════════
   NEXT QUESTION
════════════════════════════════════════════════ */
btnNext.addEventListener("click", function () {
  state.currentIndex++;
  if (state.currentIndex >= questions.length) {
    endQuiz("finished");
  } else {
    renderQuestion();
  }
});

/* ════════════════════════════════════════════════
   END QUIZ
   reason: 'finished' (all questions answered) or
   'timeout' (countdown reached zero). This is recorded
   into history so a student or supervisor can later see
   whether an attempt was completed or cut short by time.
════════════════════════════════════════════════ */
function endQuiz(reason) {
  stopTimer();
  state.completed = true;
  state.completionReason = reason;
  clearProgress();
  saveHistoryEntry(reason);
  showResults();
  showScreen("results");
}

/* ════════════════════════════════════════════════
   HISTORY (localStorage)
   Offline-first record of past attempts, per the
   thesis's documented client-side-only constraint —
   no server, no accounts; history lives on this device.
════════════════════════════════════════════════ */
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveHistoryEntry(reason) {
  try {
    const correct = state.answers.filter((a) => a.isCorrect).length;
    const total = state.answers.length;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;

    const entry = {
      subjectId: currentSubject ? currentSubject.id : "unknown",
      subjectName: currentSubject ? currentSubject.label : "Unknown",
      date: Date.now(),
      score: state.totalScore,
      correct,
      total,
      accuracy,
      bestStreak: state.highStreak,
      reason, // 'finished' or 'timeout'
    };

    const history = loadHistory();
    history.unshift(entry); // newest first
    const trimmed = history.slice(0, 50); // cap to last 50 attempts to keep localStorage light
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch (e) {}
}

/* ════════════════════════════════════════════════
   SHOW RESULTS
════════════════════════════════════════════════ */
function showResults() {
  const correct = state.answers.filter((a) => a.isCorrect).length;
  const total = state.answers.length;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;

  document.getElementById("stat-score").textContent =
    state.totalScore.toLocaleString();
  document.getElementById("stat-accuracy").textContent = accuracy + "%";
  document.getElementById("stat-correct").textContent = `${correct}/${total}`;
  document.getElementById("stat-streak").textContent = "×" + state.highStreak;

  const reasonEl = document.getElementById("results-reason");
  if (reasonEl) {
    reasonEl.textContent =
      state.completionReason === "timeout"
        ? "⏱ Time ran out"
        : "✅ Quiz finished";
  }

  let grade = "",
    gradeColor = "";
  if (accuracy >= 90) {
    grade = "🏆 Outstanding!";
    gradeColor = "#facc15";
  } else if (accuracy >= 75) {
    grade = "⭐ Excellent!";
    gradeColor = "#22c55e";
  } else if (accuracy >= 60) {
    grade = "👍 Good Work!";
    gradeColor = "#60a5fa";
  } else if (accuracy >= 40) {
    grade = "📚 Keep Practicing";
    gradeColor = "#fb923c";
  } else {
    grade = "💪 Don't Give Up!";
    gradeColor = "#f87171";
  }

  const resultsGrade = document.getElementById("results-grade");
  resultsGrade.textContent = grade;
  resultsGrade.style.color = gradeColor;

  if (accuracy >= 60) launchConfetti();
}

/* ════════════════════════════════════════════════
   REVIEW
════════════════════════════════════════════════ */
function buildReview() {
  const list = document.getElementById("review-list");
  list.innerHTML = "";

  const answerMap = new Map(state.answers.map((a) => [a.questionId, a]));

  questions.forEach((q, qi) => {
    const ans = answerMap.get(q.id);
    const isCorrect = ans ? ans.isCorrect : false;
    const selectedShuffled = ans ? ans.shuffledIndex : -1;

    const item = document.createElement("div");
    item.className = "review-item glass anim-slide-up";
    item.style.animationDelay = qi * 0.04 + "s";

    const optsHtml = q.shuffledOptions
      .map((opt, i) => {
        const origI = q.originalIndices[i];
        const isCorrectOpt = origI === q.correctIndex;
        const isSelected = i === selectedShuffled;
        let cls = "review-opt";
        let marker = "";
        if (isCorrectOpt) {
          cls += " correct-opt";
          marker = " ✓";
        } else if (isSelected && !isCorrectOpt) {
          cls += " wrong-opt";
          marker = " ✗";
        }

        return `<div class="${cls}"><span class="review-opt-letter">${LETTERS[i]}</span><span>${opt}${marker}</span></div>`;
      })
      .join("");

    item.innerHTML = `
      <div class="review-item-header">
        <div class="review-icon ${isCorrect ? "correct-icon" : "wrong-icon"}">${isCorrect ? "✓" : "✗"}</div>
        <div>
          <div class="review-q-label">Question ${qi + 1}</div>
          <div class="review-q-text">${q.question}</div>
        </div>
      </div>
      <div class="review-opts">${optsHtml}</div>
      <div class="review-explanation">${q.explanation}</div>
    `;
    list.appendChild(item);
  });
}

/* ════════════════════════════════════════════════
   SUBJECT SELECTION SCREEN
   Cards are generated dynamically from subjects.json —
   adding a new subject later means editing that one file,
   not this code.
════════════════════════════════════════════════ */
function buildSubjectScreen() {
  const grid = document.getElementById("subject-grid");
  grid.innerHTML = "";
  subjectsList.forEach((subject) => {
    const card = document.createElement("button");
    card.className = "subject-card glass";
    card.setAttribute("data-testid", `subject-card-${subject.id}`);
    card.innerHTML = `
      <div class="subject-icon">${subject.icon}</div>
      <div class="subject-label">${subject.label}</div>
      <div class="subject-meta">${subject.questionCount} Questions · ${subject.durationMins} mins</div>
    `;
    card.addEventListener("click", () => {
      if (subject.externalUrl) {
        window.location.href = subject.externalUrl;
      } else {
        startFresh(subject);
      }
    });
    grid.appendChild(card);
  });
}

/* ════════════════════════════════════════════════
   HISTORY SCREEN
   Renders past attempts from localStorage — works fully
   offline since it never leaves the device.
════════════════════════════════════════════════ */
function buildHistoryScreen() {
  const list = document.getElementById("history-list");
  list.innerHTML = "";

  const history = loadHistory();
  if (history.length === 0) {
    list.innerHTML =
      '<p class="history-empty">No quiz attempts yet. Start a quiz to build your history!</p>';
    return;
  }

  history.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item glass";
    const dateStr = new Date(entry.date).toLocaleString();
    const reasonBadge =
      entry.reason === "timeout"
        ? '<span class="history-badge timeout">⏱ Time ran out</span>'
        : '<span class="history-badge finished">✅ Finished</span>';

    item.innerHTML = `
      <div class="history-item-header">
        <div class="history-subject">${entry.subjectName}</div>
        ${reasonBadge}
      </div>
      <div class="history-stats">
        <span>⭐ ${entry.score} pts</span>
        <span>🎯 ${entry.accuracy}%</span>
        <span>📚 ${entry.correct}/${entry.total}</span>
        <span>🔥 ×${entry.bestStreak}</span>
      </div>
      <div class="history-date">${dateStr}</div>
    `;
    list.appendChild(item);
  });
}

const CONFETTI_COLORS = [
  "#9333ea",
  "#a855f7",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#f97316",
];

function launchConfetti() {
  const container = document.getElementById("confetti-container");
  container.innerHTML = "";
  for (let i = 0; i < 80; i++) {
    const el = document.createElement("div");
    el.className = "confetti-piece";
    const size = 8 + Math.random() * 8;
    el.style.cssText = `
      left: ${Math.random() * 100}%;
      top: -${size}px;
      width: ${size}px;
      height: ${size}px;
      background: ${CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]};
      border-radius: ${Math.random() > 0.5 ? "50%" : "2px"};
      animation-duration: ${2.5 + Math.random() * 2}s;
      animation-delay: ${Math.random() * 1.5}s;
    `;
    container.appendChild(el);
  }
  setTimeout(() => {
    container.innerHTML = "";
  }, 5000);
}

/* ════════════════════════════════════════════════
   START FRESH
   Now subject-aware: accepts the subject object chosen
   on the subject-select screen, fetches its question
   bank, and uses its configured duration.
════════════════════════════════════════════════ */
async function startFresh(subject) {
  currentSubject = subject;
  quizDurationMs = subject.durationMins * 60 * 1000;

  clearProgress(); // any saved session is discarded once a (possibly different) subject is chosen, per spec
  quizData = await loadQuestionBank(subject);
  questions = prepareQuestions();

  state = {
    subjectId: subject.id,
    currentIndex: 0,
    totalScore: 0,
    currentStreak: 0,
    highStreak: 0,
    answers: [],
    completed: false,
  };

  // Reset UI
  badgeScore.textContent = "0";
  badgeStreak.textContent = "0";
  badgeStreakW.classList.remove("hot");
  badgeTimer.classList.remove("urgent", "anim-timer-urgent");
  timerText.textContent = formatTime(quizDurationMs);

  endTime = Date.now() + quizDurationMs;
  saveProgress();
  startTimer();
  renderQuestion();
  showScreen("quiz");
}

/* ════════════════════════════════════════════════
   RESUME
   Looks up which subject the saved session belongs to
   and re-fetches that subject's question bank.
════════════════════════════════════════════════ */
async function resumeSession() {
  const saved = loadProgress();
  if (!saved) {
    showScreen("subjects");
    return;
  }

  const subject = subjectsList.find((s) => s.id === saved.subjectId);
  if (!subject) {
    clearProgress();
    showScreen("subjects");
    return;
  } // saved data refers to a subject we can't find — bail safely

  currentSubject = subject;
  quizDurationMs = subject.durationMins * 60 * 1000;
  quizData = await loadQuestionBank(subject);
  questions = prepareQuestions();

  state = {
    subjectId: subject.id,
    currentIndex: saved.currentIndex || 0,
    totalScore: saved.totalScore || 0,
    currentStreak: saved.currentStreak || 0,
    highStreak: saved.highStreak || 0,
    answers: saved.answers || [],
    completed: false,
  };

  badgeScore.textContent = state.totalScore;
  badgeStreak.textContent = state.currentStreak;
  endTime = saved.endTime;

  if (Date.now() > endTime - 5000) {
    badgeTimer.classList.add("urgent", "anim-timer-urgent");
  }

  startTimer();
  renderQuestion();
  showScreen("quiz");
}

/* ════════════════════════════════════════════════
   BUTTON WIRING
════════════════════════════════════════════════ */
document.getElementById("btn-start").addEventListener("click", function () {
  buildSubjectScreen();
  showScreen("subjects");
});

document.getElementById("btn-resume").addEventListener("click", resumeSession);
document.getElementById("btn-restart").addEventListener("click", function () {
  buildSubjectScreen();
  showScreen("subjects");
});

document.getElementById("btn-review").addEventListener("click", function () {
  buildReview();
  showScreen("review");
});

document
  .getElementById("btn-back-review")
  .addEventListener("click", function () {
    showScreen("results");
  });

document
  .getElementById("btn-back-results")
  .addEventListener("click", function () {
    showScreen("results");
  });

const btnBackHome = document.getElementById("btn-back-home");
if (btnBackHome) {
  btnBackHome.addEventListener("click", function () {
    showScreen("home");
  });
}

const btnHistory = document.getElementById("btn-history");
if (btnHistory) {
  btnHistory.addEventListener("click", function () {
    buildHistoryScreen();
    showScreen("history");
  });
}

const btnBackHomeFromHistory = document.getElementById("btn-back-home-history");
if (btnBackHomeFromHistory) {
  btnBackHomeFromHistory.addEventListener("click", function () {
    showScreen("home");
  });
}

/* ════════════════════════════════════════════════
   INIT — load subjects, check for resume on load
════════════════════════════════════════════════ */
(async function init() {
  try {
    await loadSubjects();
  } catch (e) {
    console.error("Could not load subjects.json", e);
  }

  const saved = loadProgress();
  if (saved) {
    document.getElementById("btn-resume").style.display = "inline-block";
  }
})();

/* ════════════════════════════════════════════════
   QUIT QUIZ — manually end session and save to history
════════════════════════════════════════════════ */
const btnQuit = document.getElementById("btn-quit");
if (btnQuit) {
  btnQuit.addEventListener("click", function () {
    if (!confirm("End this quiz and save to history?")) return;
    endQuiz("abandoned");
  });
}
