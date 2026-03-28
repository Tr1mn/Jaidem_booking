import { initializeApp } from "firebase/app";
import {
  addDoc,
  collection,
  collectionGroup,
  doc,
  getDocs,
  initializeFirestore,
  orderBy,
  query,
  serverTimestamp,
  updateDoc
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
const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  useFetchStreams: false
});

window.db = db;

const state = {
  selectedHall: null,
  selectedDate: null,
  selectedPerson: null,
  selectedDesc: "Тренинг",
  currentYear: null,
  currentMonth: null,
  adminFilter: "all",
  questionTargetId: null,
  halls: [],
  people: [],
  bookings: {},
  adminRequests: [],
  descriptionOptions: ["Тренинг", "Жыйын", "Презентация", "Интервью", "Башка"]
};

const MONTHS_KY = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const DAYS_KY = ["Дш","Шш","Шр","Бш","Жм","Иш","Жк"];
const SHORT_MONTHS_KY = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

function formatDateForApi(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateForDisplay(date) {
  return date.toLocaleDateString("ru-RU");
}

function toMin(timeStr) {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
}

function minToStr(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function timestampToMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value.seconds) return value.seconds * 1000;
  return 0;
}

function getSlotsForSelectedHall() {
  if (!state.selectedHall || !state.selectedDate) return [];
  const dateKey = formatDateForApi(state.selectedDate);
  return (state.bookings[state.selectedHall.id] && state.bookings[state.selectedHall.id][dateKey]) || [];
}

async function loadInitialData() {
  try {
    const hallsSnap = await getDocs(query(collection(db, "halls"), orderBy("createdAt", "asc")));
    const peopleSnap = await getDocs(query(collection(db, "people"), orderBy("name", "asc")));

    // IMPORTANT:
    // No orderBy here, so Firestore will not demand collection-group indexes for createdAt.
    const bookingsSnap = await getDocs(collectionGroup(db, "bookings"));
    const requestsSnap = await getDocs(collectionGroup(db, "bookingRequests"));

    state.halls = hallsSnap.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    }));

    state.people = peopleSnap.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    }));

    const bookingsMap = {};
    bookingsSnap.docs.forEach(docSnap => {
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

    state.bookings = bookingsMap;

    state.adminRequests = requestsSnap.docs
      .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
      .sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
  } catch (error) {
    console.error("Failed to load Firestore data:", error);
    showToast("⚠️ Firestore маалымат жүктөлгөн жок");
  }
}

function renderHallOptions() {
  const hallGrid = document.getElementById("hallGrid");

  if (!state.halls.length) {
    hallGrid.innerHTML = `<div class="empty-state"><div class="icon">🏛</div><p>Залдар азырынча жок</p></div>`;
    return;
  }

  hallGrid.innerHTML = state.halls.map(hall => `
    <button class="hall-btn ${state.selectedHall?.id === hall.id ? "selected" : ""}" onclick="selectHall('${hall.id}')">
      <div class="hall-icon">${hall.icon || "🏛"}</div>
      <div class="hall-name">${hall.name}</div>
      <div class="hall-cap">${hall.address || ""}</div>
    </button>
  `).join("");
}

function renderDescriptionOptions() {
  const wrap = document.getElementById("descChips");
  wrap.innerHTML = state.descriptionOptions.map(option => `
    <button class="chip ${state.selectedDesc === option ? "selected" : ""}" onclick="selectDesc('${option}')">${option}</button>
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

  if (totalBooked >= 840) return "red";
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

  for (let i = 0; i < offset; i++) {
    grid.innerHTML += `<div class="cal-day empty"></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
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

  if (!state.selectedHall) {
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

  const DAY_START = 540;
  const DAY_END = 1440;
  const segments = [];
  let cursor = DAY_START;

  for (const slot of slots) {
    if (cursor < slot.start) {
      segments.push({ type: "free", start: cursor, end: slot.start });
    }

    segments.push({
      type: "busy",
      start: slot.start,
      end: slot.end,
      bookedBy: slot.bookedBy,
      role: slot.role
    });

    cursor = Math.max(cursor, slot.end);
  }

  if (cursor < DAY_END) {
    segments.push({ type: "free", start: cursor, end: DAY_END });
  }

  titleEl.textContent = `📅 ${day} ${SHORT_MONTHS_KY[state.currentMonth]} күнүнүн графиги`;

  timeline.innerHTML = segments.map(segment => {
    const endLabel = segment.end === 1440 ? "00:00" : minToStr(segment.end);

    if (segment.type === "busy") {
      const initials = (segment.bookedBy || "?")
        .split(" ")
        .map(word => word[0])
        .join("")
        .slice(0, 2);

      return `
        <div class="timeline-row busy" style="align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="timeline-dot"></div>
            <div>
              <div class="timeline-time" style="color:var(--red);">🔴 ${minToStr(segment.start)} – ${endLabel}</div>
              <div style="font-size:11px;color:var(--red);opacity:0.8;margin-top:2px;">Ээленген</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:7px;background:rgba(255,71,87,0.12);border-radius:10px;padding:5px 10px;">
            <div style="width:26px;height:26px;border-radius:50%;background:var(--red);color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;flex-shrink:0;">${initials}</div>
            <div>
              <div style="font-size:12px;font-weight:800;color:var(--red);">${segment.bookedBy || "—"}</div>
              <div style="font-size:10px;color:var(--red);opacity:0.75;">${segment.role || ""}</div>
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="timeline-row free">
        <div class="timeline-dot"></div>
        <div class="timeline-time">🟢 ${minToStr(segment.start)} – ${endLabel}</div>
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

  if (startMin < 540) {
    errorEl.textContent = "⛔ Брондоо 09:00дан башталат";
    return false;
  }

  if (endMin < startMin + 30) {
    errorEl.textContent = "⛔ Минималдуу узактыгы — 30 мүнөт";
    return false;
  }

  if (endMin > 1440) {
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

function normalizeSearchText(value) {
  return (value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function transliterateCyrillicToLatin(value) {
  const map = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "yo",
    ж: "zh",
    з: "z",
    и: "i",
    й: "i",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    ң: "ng",
    о: "o",
    ө: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ү: "u",
    ф: "f",
    х: "h",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "sh",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya"
  };

  return normalizeSearchText(value)
    .split("")
    .map(char => map[char] ?? char)
    .join("");
}

function getPersonSearchTokens(person) {
  const fields = [
    person.name || "",
    person.role || "",
    person.initials || ""
  ];

  return fields.flatMap(field => {
    const normalized = normalizeSearchText(field);
    const transliterated = transliterateCyrillicToLatin(field);
    return [normalized, transliterated].filter(Boolean);
  });
}

function searchPerson(queryText) {
  const dropdown = document.getElementById("personDropdown");
  const query = normalizeSearchText(queryText);

  if (!query) {
    dropdown.style.display = "none";
    return;
  }

  if (!state.people.length) {
    dropdown.innerHTML = `
      <div class="dropdown-empty">
        Адамдардын тизмеси жүктөлгөн жок же азырынча бош.
      </div>
    `;
    dropdown.style.display = "block";
    return;
  }

  const queryVariants = [
    query,
    transliterateCyrillicToLatin(query)
  ].filter(Boolean);

  const results = state.people.filter(person =>
    getPersonSearchTokens(person).some(token =>
      queryVariants.some(queryVariant => token.includes(queryVariant))
    )
  );

  if (!results.length) {
    dropdown.innerHTML = `
      <div class="dropdown-empty">
        Суроо боюнча адам табылган жок.
      </div>
    `;
    dropdown.style.display = "block";
    return;
  }

  dropdown.innerHTML = results.map(person => `
    <div class="dropdown-item" onclick="choosePerson('${person.id}')">
      <div class="avatar">${person.initials || "?"}</div>
      <div>
        <div style="font-weight:700">${person.name}</div>
        <div class="person-role">${person.role || ""}</div>
      </div>
    </div>
  `).join("");

  dropdown.style.display = "block";
}

function choosePerson(id) {
  const person = state.people.find(item => item.id === id);
  if (!person) return;

  state.selectedPerson = person;
  document.getElementById("personSearch").value = "";
  document.getElementById("personDropdown").style.display = "none";
  document.getElementById("selectedAvatar").textContent = person.initials || "?";
  document.getElementById("selectedName").textContent = person.name;
  document.getElementById("selectedRole").textContent = person.role || "";
  document.getElementById("selectedPersonEl").style.display = "flex";
}

function clearPerson() {
  state.selectedPerson = null;
  document.getElementById("selectedPersonEl").style.display = "none";
}

document.addEventListener("click", event => {
  if (!event.target.closest(".search-wrap")) {
    document.getElementById("personDropdown").style.display = "none";
  }
});

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

async function submitBooking() {
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

  if (!state.selectedPerson) {
    showToast("❗ Арыз берүүчүнү тандаңыз");
    return;
  }

  const description = state.selectedDesc === "Башка"
    ? (document.getElementById("descTextarea").value.trim() || "Башка")
    : state.selectedDesc;

  const timeStart = document.getElementById("timeStart").value;
  const timeEnd = document.getElementById("timeEnd").value;
  const dateKey = formatDateForApi(state.selectedDate);

  try {
    await addDoc(collection(db, "halls", state.selectedHall.id, "bookingRequests"), {
      hallId: state.selectedHall.id,
      hallName: state.selectedHall.name,
      personId: state.selectedPerson.id,
      personName: state.selectedPerson.name,
      personRole: state.selectedPerson.role || "",
      date: formatDateForDisplay(state.selectedDate),
      dateKey,
      timeStart,
      timeEnd,
      desc: description,
      status: "pending",
      question: "",
      created: new Date().toLocaleString("ru-RU"),
      createdAt: serverTimestamp()
    });

    await addDoc(collection(db, "halls", state.selectedHall.id, "bookings"), {
      hallId: state.selectedHall.id,
      hallName: state.selectedHall.name,
      date: dateKey,
      start: toMin(timeStart),
      end: toMin(timeEnd),
      bookedBy: state.selectedPerson.name,
      role: state.selectedPerson.role || "",
      createdAt: serverTimestamp()
    });

    await loadInitialData();
    renderCalendar();
    updatePendingBadge();

    document.getElementById("successBanner").classList.add("show");
    document.getElementById("submitBtn").disabled = true;
    showToast("✅ Арыз жөнөтүлдү!");

    setTimeout(() => {
      document.getElementById("successBanner").classList.remove("show");
      document.getElementById("submitBtn").disabled = false;
      resetBookingForm();
    }, 2500);
  } catch (error) {
    console.error("Failed to create booking request:", error);
    showToast("⚠️ Арыз жөнөтүлгөн жок");
  }
  console.log("successfully")
}

function resetBookingForm() {
  state.selectedHall = null;
  state.selectedDate = null;
  state.selectedPerson = null;
  state.selectedDesc = "Тренинг";

  document.getElementById("timeStart").value = "09:00";
  document.getElementById("timeEnd").value = "10:00";
  document.getElementById("descTextarea").value = "";
  document.getElementById("descTextarea").classList.remove("visible");
  document.getElementById("daySchedule").style.display = "none";

  clearPerson();
  renderHallOptions();
  renderDescriptionOptions();
  initCalendar();
}

function filterAdmin(filter, button) {
  state.adminFilter = filter;
  document.querySelectorAll(".admin-tab").forEach(tab => tab.classList.remove("active"));
  button.classList.add("active");
  renderAdmin();
}

function renderAdmin() {
  const list = document.getElementById("adminList");

  const filtered = state.adminFilter === "all"
    ? state.adminRequests
    : state.adminRequests.filter(request => request.status === state.adminFilter);

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>Арыздар жок</p></div>`;
    return;
  }

  const statusLabel = {
    pending: "Каралууда",
    approved: "Тастыкталган",
    rejected: "Четке кагылган",
    question: "Суроо бар"
  };

  list.innerHTML = filtered.map(request => `
    <div class="request-card ${request.status}" id="req-${request.id}">
      <div class="req-header">
        <div>
          <div class="req-title">${request.hallName || ""}</div>
          <div class="req-meta">Берген: ${request.personName || ""} · ${request.personRole || ""} · ${request.created || ""}</div>
        </div>
        <span class="status-badge ${request.status}">${statusLabel[request.status] || request.status}</span>
      </div>

      <div class="req-details">
        <div class="req-detail">📅 ${request.date}</div>
        <div class="req-detail">🕐 ${request.timeStart} – ${request.timeEnd}</div>
        <div class="req-detail">🎯 ${request.desc}</div>
      </div>

      ${request.question ? `<div style="background:var(--primary-soft);border-radius:10px;padding:10px 12px;font-size:13px;font-weight:600;color:var(--primary);margin-bottom:12px">💬 Суроо жөнөтүлдү: «${request.question}»</div>` : ""}

      ${(request.status === "pending" || request.status === "question") ? `
        <div class="req-actions">
          <button class="btn-sm btn-approve" onclick="setStatus('${request.id}', 'approved')">✅ Тастыктоо</button>
          <button class="btn-sm btn-reject" onclick="setStatus('${request.id}', 'rejected')">❌ Четке кагуу</button>
          <button class="btn-sm btn-question" onclick="openModal('${request.id}')">💬 Суроо берүү</button>
        </div>
      ` : ""}
    </div>
  `).join("");
}

async function setStatus(id, status) {
  try {
    const request = state.adminRequests.find(item => item.id === id);
    if (!request) {
      showToast("⚠️ Арыз табылган жок");
      return;
    }

    await updateDoc(
      doc(db, "halls", request.hallId, "bookingRequests", id),
      { status }
    );

    await loadInitialData();
    updatePendingBadge();
    renderAdmin();

    showToast(status === "approved" ? "✅ Арыз тастыкталды" : "❌ Арыз четке кагылды");
  } catch (error) {
    console.error("Failed to update status:", error);
    showToast("⚠️ Статус жаңыртылган жок");
  }
}

function openModal(id) {
  state.questionTargetId = id;
  document.getElementById("modalQuestion").value = "";
  document.getElementById("modalOverlay").classList.add("open");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
  state.questionTargetId = null;
}

async function sendQuestion() {
  const question = document.getElementById("modalQuestion").value.trim();

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
        status: "question"
      }
    );

    closeModal();
    await loadInitialData();
    updatePendingBadge();
    renderAdmin();
    showToast("💬 Суроо арыз берүүчүгө жөнөтүлдү");
  } catch (error) {
    console.error("Failed to send question:", error);
    showToast("⚠️ Суроо жөнөтүлгөн жок");
  }
}

function openPlaceModal() {
  document.getElementById("placeName").value = "";
  document.getElementById("placeAddress").value = "";
  document.getElementById("placeIcon").value = "";
  document.getElementById("placeModalOverlay").classList.add("open");
}

function closePlaceModal() {
  document.getElementById("placeModalOverlay").classList.remove("open");
}

window.createPlace = async function () {
  const name = document.getElementById("placeName").value.trim();
  const address = document.getElementById("placeAddress").value.trim();
  const icon = document.getElementById("placeIcon").value.trim() || "🏛";

  if (!name) {
    showToast("❗ Залдын атын жазыңыз");
    return;
  }

  try {
    const docRef = await addDoc(collection(db, "halls"), {
      name,
      address,
      icon,
      createdAt: serverTimestamp()
    });

    console.log("saved Firestore, id:", docRef.id);

    closePlaceModal();
    await loadInitialData();
    renderHallOptions();
    showToast("✅ Saved");
  } catch (error) {
    console.error("ADDDOC ERROR:", error);
    alert(error.message);
  }
};

function updatePendingBadge() {
  document.getElementById("pendingBadge").textContent =
    state.adminRequests.filter(item => item.status === "pending").length;
}

function showPage(page, button) {
  document.querySelectorAll(".page").forEach(element => element.classList.remove("active"));
  document.getElementById(`page-${page}`).classList.add("active");

  document.querySelectorAll(".nav-tab").forEach(tab => tab.classList.remove("active"));
  button.classList.add("active");

  if (page === "admin") {
    renderAdmin();
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2800);
}

window.changeMonth = changeMonth;
window.selectDay = selectDay;
window.selectHall = selectHall;
window.searchPerson = searchPerson;
window.choosePerson = choosePerson;
window.clearPerson = clearPerson;
window.selectDesc = selectDesc;
window.submitBooking = submitBooking;
window.filterAdmin = filterAdmin;
window.setStatus = setStatus;
window.openModal = openModal;
window.closeModal = closeModal;
window.sendQuestion = sendQuestion;
window.openPlaceModal = openPlaceModal;
window.closePlaceModal = closePlaceModal;
window.showPage = showPage;
window.validateTime = validateTime;

async function bootstrap() {
  await loadInitialData();
  renderHallOptions();
  renderDescriptionOptions();
  initCalendar();
  updatePendingBadge();
}

bootstrap();
