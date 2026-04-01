import { initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "firebase/auth";
import {
  addDoc,
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  useFetchStreams: false
});

const BOOKING_DAY_START = 540;
const BOOKING_DAY_END = 1440;
const REQUEST_STATUSES = ["pending", "approved", "rejected", "question"];
const ADMIN_REFRESH_INTERVAL_MS = 15000;

const state = {
  selectedHall: null,
  selectedDate: null,
  selectedDesc: "Тренинг",
  currentYear: null,
  currentMonth: null,
  adminFilter: "all",
  questionTargetId: null,
  halls: [],
  bookings: {},
  adminRequests: [],
  myRequests: [],
  currentUser: null,
  authMode: "login",
  authPending: false,
  descriptionOptions: ["Тренинг", "Жыйын", "Презентация", "Интервью", "Башка"],
  knownPendingRequestIds: [],
  adminNotificationReady: false
};

let adminRefreshTimer = null;

const MONTHS_KY = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const DAYS_KY = ["Дш", "Шш", "Шр", "Бш", "Жм", "Иш", "Жк"];
const SHORT_MONTHS_KY = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function formatDateForApi(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateForDisplay(date) {
  return date.toLocaleDateString("ru-RU");
}

function formatDateTimeForDisplay(value) {
  const millis = timestampToMillis(value);
  return millis ? new Date(millis).toLocaleString("ru-RU") : "";
}

function toMin(timeStr) {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
}

function minToStr(minutes) {
  if (minutes === BOOKING_DAY_END) {
    return "00:00";
  }

  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function timestampToMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value.seconds) return value.seconds * 1000;
  return 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function sanitizeSingleLine(value, maxLength = 120) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeMultiline(value, maxLength = 500) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, maxLength);
}

function normalizeEmail(value) {
  return sanitizeSingleLine(value, 254).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeGroupNumber(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .slice(0, 10);
}

function isValidGroupNumber(value) {
  return /^[0-9]+\.[0-9]+$/.test(value);
}

function formatGroupLabel(value) {
  const normalized = normalizeGroupNumber(value);
  return normalized ? `Агым ${normalized}` : "";
}

function getUserMeta(user) {
  if (!user) {
    return "";
  }

  return [
    user.email || "",
    formatGroupLabel(user.groupNumber || "")
  ].filter(Boolean).join(" · ");
}

function getInitials(value) {
  const parts = sanitizeSingleLine(value, 80).split(" ").filter(Boolean);

  if (!parts.length) {
    return "?";
  }

  return parts
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() || "")
    .join("");
}

function isAdmin() {
  return state.currentUser?.role === "admin";
}

function roleLabel(role) {
  return role === "admin" ? "Администратор" : "Колдонуучу";
}

function supportsBrowserNotifications() {
  return typeof window !== "undefined" && "Notification" in window;
}

function resetAdminNotificationState() {
  state.knownPendingRequestIds = [];
  state.adminNotificationReady = false;
}

function syncAdminRefreshLoop() {
  if (adminRefreshTimer) {
    window.clearInterval(adminRefreshTimer);
    adminRefreshTimer = null;
  }

  if (!isAdmin()) {
    return;
  }

  adminRefreshTimer = window.setInterval(() => {
    if (isAdmin() && !state.authPending) {
      refreshAppData();
    }
  }, ADMIN_REFRESH_INTERVAL_MS);
}

async function requestAdminNotificationPermission() {
  if (!isAdmin() || !supportsBrowserNotifications() || Notification.permission !== "default") {
    return;
  }

  try {
    await Notification.requestPermission();
  } catch (error) {
    console.error("Failed to request browser notification permission:", error);
  }
}

function notifyAdminAboutNewRequests(newRequests) {
  if (!newRequests.length) {
    return;
  }

  const latestRequest = newRequests[0];
  const requestCountLabel = newRequests.length > 1 ? `${newRequests.length} жаңы арыз` : "Жаңы арыз";
  const latestUser = sanitizeSingleLine(latestRequest.userName || "Колдонуучу", 80);
  const latestHall = sanitizeSingleLine(latestRequest.hallName || "зал", 80);

  showToast(`🔔 ${requestCountLabel}: ${latestUser} · ${latestHall}`);

  if (supportsBrowserNotifications() && Notification.permission === "granted") {
    const body = newRequests.length > 1
      ? `Акыркысы: ${latestUser} — ${latestHall}`
      : `${latestUser} ${latestHall} үчүн брондоо жөнөттү`;

    new Notification("Жаңы брондоо арызы", {
      body,
      tag: "jaidem-booking-admin",
      renotify: true
    });
  }
}

function processAdminNotifications() {
  if (!isAdmin()) {
    resetAdminNotificationState();
    return;
  }

  const pendingRequests = state.adminRequests.filter(item => safeStatus(item.status) === "pending");
  const pendingRequestIds = pendingRequests.map(item => item.id);

  if (!state.adminNotificationReady) {
    state.knownPendingRequestIds = pendingRequestIds;
    state.adminNotificationReady = true;
    return;
  }

  const knownIds = new Set(state.knownPendingRequestIds);
  const newRequests = pendingRequests.filter(item => !knownIds.has(item.id));

  state.knownPendingRequestIds = pendingRequestIds;
  notifyAdminAboutNewRequests(newRequests);
}

function safeStatus(status) {
  return REQUEST_STATUSES.includes(status) ? status : "pending";
}

function statusLabel(status) {
  return {
    pending: "Каралууда",
    approved: "Тастыкталган",
    rejected: "Четке кагылган",
    question: "Суроо бар"
  }[safeStatus(status)];
}

function getRequestMeta(request) {
  return formatDateTimeForDisplay(request.updatedAt || request.createdAt);
}

function clearAuthenticatedState() {
  state.selectedHall = null;
  state.selectedDate = null;
  state.questionTargetId = null;
  state.halls = [];
  state.bookings = {};
  state.adminRequests = [];
  state.myRequests = [];
  resetAdminNotificationState();
  document.getElementById("daySchedule").style.display = "none";
}

function buildBookingsMap(snapshot) {
  const bookingsMap = {};

  snapshot.docs.forEach(docSnap => {
    const booking = { id: docSnap.id, ...docSnap.data() };

    if (!bookingsMap[booking.hallId]) bookingsMap[booking.hallId] = {};
    if (!bookingsMap[booking.hallId][booking.date]) bookingsMap[booking.hallId][booking.date] = [];
    bookingsMap[booking.hallId][booking.date].push(booking);
  });

  Object.keys(bookingsMap).forEach(hallId => {
    Object.keys(bookingsMap[hallId]).forEach(dateKey => {
      bookingsMap[hallId][dateKey].sort((a, b) => a.start - b.start);
    });
  });

  return bookingsMap;
}

async function ensureUserProfile(user, preferredName = "", preferredGroupNumber = "") {
  const userRef = doc(db, "users", user.uid);
  const existing = await getDoc(userRef);
  const fallbackName = sanitizeSingleLine(preferredName || user.displayName || user.email?.split("@")[0] || "Колдонуучу", 80);
  const fallbackGroupNumber = normalizeGroupNumber(preferredGroupNumber);

  if (!existing.exists()) {
    const newProfile = {
      uid: user.uid,
      email: normalizeEmail(user.email || ""),
      name: fallbackName,
      role: "user",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    if (fallbackGroupNumber) {
      newProfile.groupNumber = fallbackGroupNumber;
    }

    await setDoc(userRef, newProfile);

    return {
      uid: user.uid,
      email: normalizeEmail(user.email || ""),
      name: fallbackName,
      role: "user",
      groupNumber: fallbackGroupNumber
    };
  }

  const profile = existing.data();
  const normalizedGroupNumber = normalizeGroupNumber(profile.groupNumber || fallbackGroupNumber);
  const normalizedProfile = {
    uid: user.uid,
    email: normalizeEmail(profile.email || user.email || ""),
    name: sanitizeSingleLine(profile.name || fallbackName, 80) || fallbackName,
    role: profile.role === "admin" ? "admin" : "user",
    groupNumber: normalizedGroupNumber
  };

  const profileUpdates = {};

  if (!profile.name && fallbackName) {
    profileUpdates.name = fallbackName;
  }

  if (!profile.groupNumber && fallbackGroupNumber) {
    profileUpdates.groupNumber = fallbackGroupNumber;
  }

  if (Object.keys(profileUpdates).length) {
    await updateDoc(userRef, {
      ...profileUpdates,
      updatedAt: serverTimestamp()
    });
  }

  return normalizedProfile;
}

async function loadUserRequests(uid, halls) {
  if (!uid || !halls.length) {
    return [];
  }

  const requestSnapshots = await Promise.allSettled(
    halls.map(hall =>
      getDocs(query(collection(db, "halls", hall.id, "bookingRequests"), where("userId", "==", uid)))
    )
  );

  return requestSnapshots
    .flatMap((snapshot, index) => {
      if (snapshot.status !== "fulfilled") {
        console.error(`Failed to load booking requests for hall ${halls[index]?.id || "unknown"}:`, snapshot.reason);
        return [];
      }

      return snapshot.value.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    })
    .sort((a, b) => timestampToMillis(b.updatedAt || b.createdAt) - timestampToMillis(a.updatedAt || a.createdAt));
}

async function refreshAppData() {
  if (!state.currentUser) {
    clearAuthenticatedState();
    renderHallOptions();
    renderCalendar();
    renderBookingIdentity();
    renderMyRequests();
    renderAdmin();
    updatePendingBadge();
    updateAuthUI();
    return;
  }

  try {
    const [hallsResult, bookingsResult, adminRequestsResult] = await Promise.allSettled([
      getDocs(query(collection(db, "halls"), orderBy("createdAt", "asc"))),
      getDocs(collectionGroup(db, "bookings")),
      isAdmin() ? getDocs(collectionGroup(db, "bookingRequests")) : Promise.resolve(null)
    ]);

    let hasPartialFailure = false;

    if (hallsResult.status === "fulfilled") {
      state.halls = hallsResult.value.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      }));
    } else {
      hasPartialFailure = true;
      state.halls = [];
      console.error("Failed to load halls:", hallsResult.reason);
    }

    if (bookingsResult.status === "fulfilled") {
      state.bookings = buildBookingsMap(bookingsResult.value);
    } else {
      hasPartialFailure = true;
      state.bookings = {};
      console.error("Failed to load bookings:", bookingsResult.reason);
    }

    try {
      state.myRequests = await loadUserRequests(state.currentUser.uid, state.halls);
    } catch (error) {
      hasPartialFailure = true;
      state.myRequests = [];
      console.error("Failed to load current user requests:", error);
    }

    if (isAdmin()) {
      if (adminRequestsResult.status === "fulfilled" && adminRequestsResult.value) {
        state.adminRequests = adminRequestsResult.value.docs
          .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
          .sort((a, b) => timestampToMillis(b.updatedAt || b.createdAt) - timestampToMillis(a.updatedAt || a.createdAt));
      } else {
        hasPartialFailure = true;
        state.adminRequests = [];
        console.error("Failed to load admin requests:", adminRequestsResult.status === "rejected" ? adminRequestsResult.reason : "No data");
      }
    } else {
      state.adminRequests = [];
    }

    if (state.selectedHall) {
      state.selectedHall = state.halls.find(hall => hall.id === state.selectedHall.id) || null;
    }

    if (state.currentYear === null || state.currentMonth === null) {
      initCalendar();
    } else {
      renderCalendar();
    }

    renderHallOptions();
    renderBookingIdentity();
    renderMyRequests();
    renderAdmin();
    processAdminNotifications();
    updatePendingBadge();
    updateAuthUI();

    if (hasPartialFailure) {
      showToast("⚠️ Айрым Firebase маалыматтары толук жүктөлгөн жок");
    }
  } catch (error) {
    console.error("Failed to load Firestore data:", error);
    renderHallOptions();
    renderCalendar();
    renderBookingIdentity();
    renderMyRequests();
    renderAdmin();
    updatePendingBadge();
    updateAuthUI();
    showToast("⚠️ Firebase маалымат жүктөлгөн жок");
  }
}

function renderHallOptions() {
  const hallGrid = document.getElementById("hallGrid");

  if (!state.currentUser) {
    hallGrid.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔐</div>
        <p>Алгач аккаунтка кириңиз же катталыңыз</p>
      </div>
    `;
    return;
  }

  if (!state.halls.length) {
    hallGrid.innerHTML = `
      <div class="empty-state">
        <div class="icon">🏛</div>
        <p>Залдар азырынча жок</p>
      </div>
    `;
    return;
  }

  hallGrid.innerHTML = state.halls.map(hall => `
    <button class="hall-btn ${state.selectedHall?.id === hall.id ? "selected" : ""}" onclick="selectHall('${hall.id}')">
      <div class="hall-icon">${escapeHtml(hall.icon || "🏛")}</div>
      <div class="hall-name">${escapeHtml(hall.name || "Зал")}</div>
      <div class="hall-cap">${escapeHtml(hall.address || "")}</div>
    </button>
  `).join("");
}

function renderDescriptionOptions() {
  const wrap = document.getElementById("descChips");

  wrap.innerHTML = state.descriptionOptions.map(option => `
    <button class="chip ${state.selectedDesc === option ? "selected" : ""}" onclick="selectDesc('${option}')">${escapeHtml(option)}</button>
  `).join("");
}

function initCalendar() {
  const now = new Date();
  state.currentYear = now.getFullYear();
  state.currentMonth = now.getMonth();
  renderCalendar();
}

function getDayColor(day) {
  if (!state.selectedHall) return "green";

  const dateObj = new Date(state.currentYear, state.currentMonth, day);
  const dateKey = formatDateForApi(dateObj);
  const slots = (state.bookings[state.selectedHall.id] && state.bookings[state.selectedHall.id][dateKey]) || [];

  if (!slots.length) return "green";

  const totalBooked = slots.reduce((sum, slot) => sum + (slot.end - slot.start), 0);

  if (totalBooked >= (BOOKING_DAY_END - BOOKING_DAY_START)) return "red";
  if (totalBooked > 0) return "yellow";
  return "green";
}

function renderCalendar() {
  document.getElementById("calTitle").textContent = `${MONTHS_KY[state.currentMonth]} ${state.currentYear}`;

  const grid = document.getElementById("calGrid");
  grid.innerHTML = DAYS_KY.map(day => `<div class="cal-day-name">${day}</div>`).join("");

  const firstDay = new Date(state.currentYear, state.currentMonth, 1).getDay();
  const offset = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMonth = new Date(state.currentYear, state.currentMonth + 1, 0).getDate();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < offset; i += 1) {
    grid.innerHTML += `<div class="cal-day empty"></div>`;
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(state.currentYear, state.currentMonth, day);
    const isPast = date < today;
    const color = getDayColor(day);

    const isSelected =
      state.selectedDate &&
      state.selectedDate.getDate() === day &&
      state.selectedDate.getMonth() === state.currentMonth &&
      state.selectedDate.getFullYear() === state.currentYear;

    grid.innerHTML += `
      <button
        class="cal-day ${color} ${isSelected ? "selected" : ""} ${isPast ? "past" : ""}"
        ${color === "red" || isPast ? "disabled" : ""}
        onclick="selectDay(${day})"
      >
        ${day}
      </button>
    `;
  }
}

function changeMonth(direction) {
  state.currentMonth += direction;

  if (state.currentMonth > 11) {
    state.currentMonth = 0;
    state.currentYear += 1;
  }

  if (state.currentMonth < 0) {
    state.currentMonth = 11;
    state.currentYear -= 1;
  }

  state.selectedDate = null;
  document.getElementById("daySchedule").style.display = "none";
  renderCalendar();
}

function renderDaySchedule(day) {
  const panel = document.getElementById("daySchedule");
  const titleEl = document.getElementById("dayScheduleTitle");
  const timeline = document.getElementById("dayTimeline");

  if (!state.selectedHall || !day) {
    panel.style.display = "none";
    return;
  }

  const dateObj = new Date(state.currentYear, state.currentMonth, day);
  const dateKey = formatDateForApi(dateObj);
  const slots = ((state.bookings[state.selectedHall.id] && state.bookings[state.selectedHall.id][dateKey]) || [])
    .slice()
    .sort((a, b) => a.start - b.start);

  if (!slots.length) {
    panel.style.display = "none";
    return;
  }

  const segments = [];
  let cursor = BOOKING_DAY_START;

  for (const slot of slots) {
    if (cursor < slot.start) {
      segments.push({ type: "free", start: cursor, end: slot.start });
    }

    segments.push({
      type: "busy",
      start: slot.start,
      end: slot.end
    });

    cursor = Math.max(cursor, slot.end);
  }

  if (cursor < BOOKING_DAY_END) {
    segments.push({ type: "free", start: cursor, end: BOOKING_DAY_END });
  }

  titleEl.textContent = `📅 ${day} ${SHORT_MONTHS_KY[state.currentMonth]} күнүнүн графиги`;

  timeline.innerHTML = segments.map(segment => {
    if (segment.type === "busy") {
      return `
        <div class="timeline-row busy">
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="timeline-dot"></div>
            <div class="timeline-time" style="color:var(--red);">🔴 ${minToStr(segment.start)} – ${minToStr(segment.end)}</div>
          </div>
          <div class="timeline-label" style="color:var(--red);">Брондолгон</div>
        </div>
      `;
    }

    return `
      <div class="timeline-row free">
        <div class="timeline-dot"></div>
        <div class="timeline-time">🟢 ${minToStr(segment.start)} – ${minToStr(segment.end)}</div>
        <div class="timeline-label">Бош</div>
      </div>
    `;
  }).join("");

  panel.style.display = "block";
}

function selectDay(day) {
  if (getDayColor(day) === "red") return;

  state.selectedDate = new Date(state.currentYear, state.currentMonth, day);
  renderCalendar();
  validateTime();
  renderDaySchedule(day);
}

function validateTime() {
  const errorEl = document.getElementById("timeError");
  const startValue = document.getElementById("timeStart").value;
  const endValue = document.getElementById("timeEnd").value;

  if (!startValue || !endValue) {
    errorEl.textContent = "";
    return false;
  }

  const startMin = toMin(startValue);
  const endMin = toMin(endValue);

  if (startMin < BOOKING_DAY_START) {
    errorEl.textContent = "⛔ Брондоо 09:00дан башталат";
    return false;
  }

  if (endMin < startMin + 30) {
    errorEl.textContent = "⛔ Минималдуу узактыгы — 30 мүнөт";
    return false;
  }

  if (endMin > BOOKING_DAY_END) {
    errorEl.textContent = "⛔ Максималдуу аяктоо убактысы — 00:00";
    return false;
  }

  if (state.selectedHall && state.selectedDate) {
    const dateKey = formatDateForApi(state.selectedDate);
    const slots = (state.bookings[state.selectedHall.id] && state.bookings[state.selectedHall.id][dateKey]) || [];

    for (const slot of slots) {
      if (startMin < slot.end && endMin > slot.start) {
        errorEl.textContent = `⛔ Убакыт ээленген убакыт менен кесилишет (${minToStr(slot.start)}–${minToStr(slot.end)})`;
        return false;
      }
    }
  }

  errorEl.textContent = "";
  return true;
}

function selectHall(hallId) {
  state.selectedHall = state.halls.find(hall => hall.id === hallId) || null;
  state.selectedDate = null;
  document.getElementById("daySchedule").style.display = "none";
  renderHallOptions();
  renderCalendar();
  validateTime();
}

function setAuthMode(mode) {
  state.authMode = mode === "register" ? "register" : "login";
  updateAuthUI();
}

function updateAuthUI() {
  const currentUser = state.currentUser;
  const guestPanel = document.getElementById("authGuestPanel");
  const profilePanel = document.getElementById("authProfilePanel");
  const nameField = document.getElementById("authNameField");
  const groupField = document.getElementById("authGroupField");
  const submitBtn = document.getElementById("authSubmitBtn");
  const bookingSubmitBtn = document.getElementById("submitBtn");
  const navSessionLabel = document.getElementById("navSessionLabel");
  const navLogoutBtn = document.getElementById("navLogoutBtn");
  const adminNavBtn = document.getElementById("adminNavBtn");
  const adminNavLabel = document.getElementById("adminNavLabel");
  const loginModeBtn = document.getElementById("authModeLogin");
  const registerModeBtn = document.getElementById("authModeRegister");

  const isLoggedIn = Boolean(currentUser);
  const adminAccess = isAdmin();

  guestPanel.style.display = isLoggedIn ? "none" : "block";
  profilePanel.style.display = isLoggedIn ? "block" : "none";
  nameField.style.display = state.authMode === "register" ? "block" : "none";
  groupField.style.display = state.authMode === "register" ? "block" : "none";

  loginModeBtn.classList.toggle("active", state.authMode === "login");
  registerModeBtn.classList.toggle("active", state.authMode === "register");

  submitBtn.disabled = state.authPending;
  submitBtn.textContent = state.authPending
    ? (state.authMode === "login" ? "Кирүү..." : "Катталуу...")
    : (state.authMode === "login" ? "Кирүү" : "Катталуу");

  bookingSubmitBtn.disabled = !isLoggedIn;
  bookingSubmitBtn.textContent = isLoggedIn ? "Арызды жөнөтүү →" : "Алгач кириңиз же катталыңыз";

  navSessionLabel.textContent = isLoggedIn
    ? `${currentUser.name} · ${roleLabel(currentUser.role)}`
    : "Конок";
  navLogoutBtn.style.display = isLoggedIn ? "inline-flex" : "none";

  adminNavBtn.disabled = !adminAccess;
  adminNavBtn.classList.toggle("locked", !adminAccess);
  adminNavLabel.textContent = adminAccess ? "🛡 Администратор" : "🔒 Администратор";

  if (isLoggedIn) {
    document.getElementById("authUserAvatar").textContent = getInitials(currentUser.name);
    document.getElementById("authUserName").textContent = currentUser.name;
    document.getElementById("authUserMeta").textContent = getUserMeta(currentUser);
    document.getElementById("authUserRole").textContent = roleLabel(currentUser.role);
  }

  syncAdminRefreshLoop();

  if (!adminAccess && document.getElementById("page-admin").classList.contains("active")) {
    showPage("booking", document.getElementById("bookingNavBtn"));
  }
}

function renderBookingIdentity() {
  const container = document.getElementById("bookingIdentity");

  if (!state.currentUser) {
    container.classList.add("locked");
    container.innerHTML = `
      <div class="avatar">🔐</div>
      <div class="identity-copy">
        <strong>Алгач аккаунтка кириңиз</strong>
        <div class="person-role">Катталган колдонуучулар гана брондоо арызын бере алышат.</div>
      </div>
    `;
    return;
  }

  container.classList.remove("locked");
  container.innerHTML = `
    <div class="avatar">${escapeHtml(getInitials(state.currentUser.name))}</div>
    <div>
      <div class="name">${escapeHtml(state.currentUser.name)}</div>
      <div class="person-role">${escapeHtml(getUserMeta(state.currentUser))}</div>
    </div>
    <span class="role-pill">${escapeHtml(roleLabel(state.currentUser.role))}</span>
  `;
}

function renderMyRequests() {
  const list = document.getElementById("myRequestsList");

  if (!state.currentUser) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">📝</div>
        <p>Киргенден кийин өз арыздарыңызды бул жерден көрөсүз</p>
      </div>
    `;
    return;
  }

  if (!state.myRequests.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">📭</div>
        <p>Азырынча сиздин арыздарыңыз жок</p>
      </div>
    `;
    return;
  }

  list.innerHTML = `
    <div class="requests-stack">
      ${state.myRequests.map(request => {
        const requestStatus = safeStatus(request.status);
        const questionBlock = request.question
          ? `<div class="inline-note">💬 ${escapeHtml(request.question)}</div>`
          : "";

        return `
          <div class="request-card ${requestStatus}">
            <div class="req-header">
              <div>
                <div class="req-title">${escapeHtml(request.hallName || "Зал")}</div>
                <div class="req-meta">${escapeHtml(getRequestMeta(request))}</div>
              </div>
              <span class="status-badge ${requestStatus}">${escapeHtml(statusLabel(requestStatus))}</span>
            </div>
            <div class="req-details">
              <div class="req-detail">📅 ${escapeHtml(request.date || "")}</div>
              <div class="req-detail">🕐 ${escapeHtml(request.timeStart || "")} – ${escapeHtml(request.timeEnd || "")}</div>
              ${request.userGroupNumber ? `<div class="req-detail">🎓 ${escapeHtml(formatGroupLabel(request.userGroupNumber))}</div>` : ""}
              <div class="req-detail">🎯 ${escapeHtml(request.desc || "")}</div>
            </div>
            ${questionBlock}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function resetBookingForm() {
  state.selectedHall = null;
  state.selectedDate = null;
  state.selectedDesc = "Тренинг";
  document.getElementById("timeStart").value = "09:00";
  document.getElementById("timeEnd").value = "10:00";
  document.getElementById("descTextarea").value = "";
  document.getElementById("descTextarea").classList.remove("visible");
  document.getElementById("daySchedule").style.display = "none";
  renderHallOptions();
  renderDescriptionOptions();
  renderCalendar();
  renderBookingIdentity();
}

async function submitBooking() {
  if (!state.currentUser) {
    showToast("❗ Алгач кириңиз же катталыңыз");
    return;
  }

  if (!state.selectedHall) {
    showToast("❗ Залды тандаңыз");
    return;
  }

  if (!state.selectedDate) {
    showToast("❗ Күндү тандаңыз");
    return;
  }

  if (!validateTime()) {
    showToast("❗ Убакытты текшериңиз");
    return;
  }

  const description = state.selectedDesc === "Башка"
    ? sanitizeMultiline(document.getElementById("descTextarea").value, 300)
    : sanitizeSingleLine(state.selectedDesc, 80);

  if (state.selectedDesc === "Башка" && !description) {
    showToast("❗ Брондоонун максатын жазыңыз");
    return;
  }

  const timeStart = document.getElementById("timeStart").value;
  const timeEnd = document.getElementById("timeEnd").value;
  const dateKey = formatDateForApi(state.selectedDate);
  const bookingRequest = {
    hallId: state.selectedHall.id,
    hallName: sanitizeSingleLine(state.selectedHall.name, 120),
    userId: state.currentUser.uid,
    userName: sanitizeSingleLine(state.currentUser.name, 80),
    userEmail: normalizeEmail(state.currentUser.email),
    date: formatDateForDisplay(state.selectedDate),
    dateKey,
    timeStart,
    timeEnd,
    startMin: toMin(timeStart),
    endMin: toMin(timeEnd),
    desc: description || "Башка",
    status: "pending",
    question: "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  if (state.currentUser.groupNumber) {
    bookingRequest.userGroupNumber = normalizeGroupNumber(state.currentUser.groupNumber);
  }

  try {
    await addDoc(collection(db, "halls", state.selectedHall.id, "bookingRequests"), bookingRequest);

    await refreshAppData();

    document.getElementById("successBanner").classList.add("show");
    document.getElementById("submitBtn").disabled = true;
    showToast("✅ Арыз жөнөтүлдү!");

    setTimeout(() => {
      document.getElementById("successBanner").classList.remove("show");
      document.getElementById("submitBtn").disabled = !state.currentUser;
      resetBookingForm();
    }, 2500);
  } catch (error) {
    console.error("Failed to create booking request:", error);
    showToast("⚠️ Арыз жөнөтүлгөн жок");
  }
}

function filterAdmin(filter, button) {
  state.adminFilter = filter;
  document.querySelectorAll(".admin-tab").forEach(tab => tab.classList.remove("active"));

  if (button) {
    button.classList.add("active");
  }

  renderAdmin();
}

function renderAdmin() {
  const list = document.getElementById("adminList");

  if (!isAdmin()) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔒</div>
        <p>Бул бөлүм администраторлор үчүн гана жеткиликтүү</p>
      </div>
    `;
    return;
  }

  const filtered = state.adminFilter === "all"
    ? state.adminRequests
    : state.adminRequests.filter(request => request.status === state.adminFilter);

  if (!filtered.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">📭</div>
        <p>Арыздар жок</p>
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map(request => {
    const requestStatus = safeStatus(request.status);
    const questionBlock = request.question
      ? `<div class="inline-note">💬 ${escapeHtml(request.question)}</div>`
      : "";

    return `
      <div class="request-card ${requestStatus}" id="req-${request.id}">
        <div class="req-header">
          <div>
            <div class="req-title">${escapeHtml(request.hallName || "")}</div>
            <div class="req-meta">
              Берген: ${escapeHtml(request.userName || "")} · ${escapeHtml(request.userEmail || "")}${request.userGroupNumber ? ` · ${escapeHtml(formatGroupLabel(request.userGroupNumber))}` : ""} · ${escapeHtml(getRequestMeta(request))}
            </div>
          </div>
          <span class="status-badge ${requestStatus}">${escapeHtml(statusLabel(requestStatus))}</span>
        </div>

        <div class="req-details">
          <div class="req-detail">📅 ${escapeHtml(request.date || "")}</div>
          <div class="req-detail">🕐 ${escapeHtml(request.timeStart || "")} – ${escapeHtml(request.timeEnd || "")}</div>
          ${request.userGroupNumber ? `<div class="req-detail">🎓 ${escapeHtml(formatGroupLabel(request.userGroupNumber))}</div>` : ""}
          <div class="req-detail">🎯 ${escapeHtml(request.desc || "")}</div>
        </div>

        ${questionBlock}

        ${(requestStatus === "pending" || requestStatus === "question") ? `
          <div class="req-actions">
            <button class="btn-sm btn-approve" onclick="setStatus('${request.id}', 'approved')">✅ Тастыктоо</button>
            <button class="btn-sm btn-reject" onclick="setStatus('${request.id}', 'rejected')">❌ Четке кагуу</button>
            <button class="btn-sm btn-question" onclick="openModal('${request.id}')">💬 Суроо берүү</button>
          </div>
        ` : ""}
      </div>
    `;
  }).join("");
}

async function approveRequest(request) {
  const bookingsRef = collection(db, "halls", request.hallId, "bookings");
  const startMin = Number(request.startMin ?? toMin(request.timeStart));
  const endMin = Number(request.endMin ?? toMin(request.timeEnd));

  const dayBookingsSnap = await getDocs(query(bookingsRef, where("date", "==", request.dateKey)));
  const hasConflict = dayBookingsSnap.docs.some(docSnap => {
    const booking = docSnap.data();
    return startMin < booking.end && endMin > booking.start;
  });

  if (hasConflict) {
    throw new Error("Бул убакыт аралыгы эми бош эмес.");
  }

  await addDoc(bookingsRef, {
    hallId: request.hallId,
    date: request.dateKey,
    start: startMin,
    end: endMin,
    userId: request.userId,
    requestId: request.id,
    createdAt: serverTimestamp()
  });

  await updateDoc(
    doc(db, "halls", request.hallId, "bookingRequests", request.id),
    {
      status: "approved",
      updatedAt: serverTimestamp()
    }
  );
}

async function setStatus(id, status) {
  if (!isAdmin()) {
    showToast("⚠️ Бул аракет админ үчүн гана");
    return;
  }

  const request = state.adminRequests.find(item => item.id === id);

  if (!request) {
    showToast("⚠️ Арыз табылган жок");
    return;
  }

  try {
    if (status === "approved") {
      await approveRequest(request);
      showToast("✅ Арыз тастыкталды");
    } else {
      await updateDoc(
        doc(db, "halls", request.hallId, "bookingRequests", id),
        {
          status: "rejected",
          updatedAt: serverTimestamp()
        }
      );
      showToast("❌ Арыз четке кагылды");
    }

    await refreshAppData();
    renderDaySchedule(state.selectedDate?.getDate() || 0);
  } catch (error) {
    console.error("Failed to update status:", error);
    showToast(error.message || "⚠️ Статус жаңыртылган жок");
  }
}

function openModal(id) {
  if (!isAdmin()) {
    showToast("⚠️ Бул аракет админ үчүн гана");
    return;
  }

  state.questionTargetId = id;
  document.getElementById("modalQuestion").value = "";
  document.getElementById("modalOverlay").classList.add("open");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
  state.questionTargetId = null;
}

async function sendQuestion() {
  const question = sanitizeMultiline(document.getElementById("modalQuestion").value, 500);

  if (!question) {
    showToast("❗ Суроону жазыңыз");
    return;
  }

  try {
    const request = state.adminRequests.find(item => item.id === state.questionTargetId);

    if (!request) {
      showToast("⚠️ Арыз табылган жок");
      return;
    }

    await updateDoc(
      doc(db, "halls", request.hallId, "bookingRequests", state.questionTargetId),
      {
        question,
        status: "question",
        updatedAt: serverTimestamp()
      }
    );

    closeModal();
    await refreshAppData();
    showToast("💬 Суроо жөнөтүлдү");
  } catch (error) {
    console.error("Failed to send question:", error);
    showToast("⚠️ Суроо жөнөтүлгөн жок");
  }
}

function openPlaceModal() {
  if (!isAdmin()) {
    showToast("⚠️ Бул аракет админ үчүн гана");
    return;
  }

  document.getElementById("placeName").value = "";
  document.getElementById("placeAddress").value = "";
  document.getElementById("placeIcon").value = "";
  document.getElementById("placeModalOverlay").classList.add("open");
}

function closePlaceModal() {
  document.getElementById("placeModalOverlay").classList.remove("open");
}

async function createPlace() {
  if (!isAdmin()) {
    showToast("⚠️ Бул аракет админ үчүн гана");
    return;
  }

  const name = sanitizeSingleLine(document.getElementById("placeName").value, 80);
  const address = sanitizeSingleLine(document.getElementById("placeAddress").value, 140);
  const icon = sanitizeSingleLine(document.getElementById("placeIcon").value, 4) || "🏛";

  if (!name) {
    showToast("❗ Залдын атын жазыңыз");
    return;
  }

  try {
    await addDoc(collection(db, "halls"), {
      name,
      address,
      icon,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    closePlaceModal();
    await refreshAppData();
    showToast("✅ Зал кошулду");
  } catch (error) {
    console.error("Failed to create hall:", error);
    showToast("⚠️ Зал сакталган жок");
  }
}

function updatePendingBadge() {
  const pendingCount = isAdmin()
    ? state.adminRequests.filter(item => safeStatus(item.status) === "pending").length
    : 0;

  const pendingBadge = document.getElementById("pendingBadge");
  const adminNavBadge = document.getElementById("adminNavBadge");

  pendingBadge.textContent = pendingCount;
  adminNavBadge.textContent = pendingCount;
  adminNavBadge.style.display = pendingCount > 0 && isAdmin() ? "inline-flex" : "none";
}

function showPage(page, button) {
  if (page === "admin" && !isAdmin()) {
    showToast("🔒 Админ панель үчүн admin аккаунт керек");
    return;
  }

  document.querySelectorAll(".page").forEach(element => element.classList.remove("active"));
  document.getElementById(`page-${page}`).classList.add("active");

  document.querySelectorAll(".nav-tab").forEach(tab => tab.classList.remove("active"));
  if (button) {
    button.classList.add("active");
  }

  if (page === "admin") {
    requestAdminNotificationPermission();
    renderAdmin();
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2800);
}

function selectDesc(value) {
  state.selectedDesc = value;
  renderDescriptionOptions();

  const textarea = document.getElementById("descTextarea");
  if (value === "Башка") {
    textarea.classList.add("visible");
  } else {
    textarea.classList.remove("visible");
    textarea.value = "";
  }
}

function getAuthErrorMessage(error) {
  switch (error?.code) {
    case "auth/configuration-not-found":
    case "auth/operation-not-allowed":
      return "Firebase Authentication даяр эмес. Firebase Console'до Email/Password кирүүсүн күйгүзүңүз.";
    case "auth/email-already-in-use":
      return "Бул email менен аккаунт мурунтан бар.";
    case "auth/invalid-email":
      return "Email туура эмес жазылган.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Email же сырсөз туура эмес.";
    case "auth/weak-password":
      return "Сырсөз өтө алсыз. Кеминде 8 белги жазыңыз.";
    case "auth/too-many-requests":
      return "Сураныч, бир аздан кийин кайра аракет кылыңыз.";
    default:
      return "Аутентификация аткарылган жок.";
  }
}

async function submitAuth() {
  const email = normalizeEmail(document.getElementById("authEmail").value);
  const password = document.getElementById("authPassword").value;
  const name = sanitizeSingleLine(document.getElementById("authName").value, 80);
  const groupNumber = normalizeGroupNumber(document.getElementById("authGroupNumber").value);

  if (!isValidEmail(email)) {
    showToast("❗ Туура email жазыңыз");
    return;
  }

  if (password.length < 8) {
    showToast("❗ Сырсөз кеминде 8 белгиден турушу керек");
    return;
  }

  if (state.authMode === "register" && name.length < 2) {
    showToast("❗ Аты-жөнүңүздү жазыңыз");
    return;
  }

  if (state.authMode === "register" && !isValidGroupNumber(groupNumber)) {
    showToast("❗ Агымды 1.0 форматында жазыңыз");
    return;
  }

  state.authPending = true;
  updateAuthUI();

  try {
    if (state.authMode === "register") {
      const credentials = await createUserWithEmailAndPassword(auth, email, password);

      await updateProfile(credentials.user, { displayName: name });
      state.currentUser = await ensureUserProfile(credentials.user, name, groupNumber);
      await refreshAppData();
      showToast("✅ Аккаунт түзүлдү");
    } else {
      await signInWithEmailAndPassword(auth, email, password);
      showToast("✅ Ийгиликтүү кирдиңиз");
    }

    document.getElementById("authPassword").value = "";
    if (state.authMode === "register") {
      document.getElementById("authName").value = "";
      document.getElementById("authGroupNumber").value = "";
    }
  } catch (error) {
    console.error("Auth action failed:", error);
    showToast(`⚠️ ${getAuthErrorMessage(error)}`);
  } finally {
    state.authPending = false;
    updateAuthUI();
  }
}

async function logoutUser() {
  try {
    await signOut(auth);
    showToast("👋 Аккаунттан чыктыңыз");
  } catch (error) {
    console.error("Logout failed:", error);
    showToast("⚠️ Чыгуу мүмкүн болгон жок");
  }
}

window.changeMonth = changeMonth;
window.selectDay = selectDay;
window.selectHall = selectHall;
window.selectDesc = selectDesc;
window.submitBooking = submitBooking;
window.filterAdmin = filterAdmin;
window.setStatus = setStatus;
window.openModal = openModal;
window.closeModal = closeModal;
window.sendQuestion = sendQuestion;
window.openPlaceModal = openPlaceModal;
window.closePlaceModal = closePlaceModal;
window.createPlace = createPlace;
window.showPage = showPage;
window.validateTime = validateTime;
window.submitAuth = submitAuth;
window.setAuthMode = setAuthMode;
window.logoutUser = logoutUser;

function attachAuthInputHandlers() {
  ["authName", "authGroupNumber", "authEmail", "authPassword"].forEach(id => {
    const element = document.getElementById(id);

    element.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitAuth();
      }
    });
  });
}

async function bootstrap() {
  renderDescriptionOptions();
  initCalendar();
  renderHallOptions();
  renderBookingIdentity();
  renderMyRequests();
  renderAdmin();
  updatePendingBadge();
  updateAuthUI();
  attachAuthInputHandlers();

  onAuthStateChanged(auth, async user => {
    state.authPending = false;

    if (!user) {
      state.currentUser = null;
      clearAuthenticatedState();
      renderHallOptions();
      renderCalendar();
      renderBookingIdentity();
      renderMyRequests();
      renderAdmin();
      updatePendingBadge();
      updateAuthUI();
      return;
    }

    try {
      state.currentUser = await ensureUserProfile(user);
      await refreshAppData();
    } catch (error) {
      console.error("Failed to sync auth state:", error);
      showToast("⚠️ Колдонуучу профили даярдалган жок");
    } finally {
      updateAuthUI();
    }
  });
}

bootstrap();
