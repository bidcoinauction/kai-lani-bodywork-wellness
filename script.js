const body = document.body;
const navToggle = document.querySelector("[data-nav-toggle]");
const navLinks = document.querySelectorAll("[data-nav] a");
const form = document.querySelector("[data-booking-form]");
const steps = [...document.querySelectorAll("[data-step]")];
const progressItems = [...document.querySelectorAll("[data-progress]")];
const summaryService = document.querySelector("[data-summary-service]");
const summaryTime = document.querySelector("[data-summary-time]");
const summaryNote = document.querySelector("[data-summary-note]");
const dateOptions = document.querySelector("[data-date-options]");
const timeOptions = document.querySelector("[data-time-options]");
const toast = document.querySelector("[data-toast]");

let currentStep = 1;
let selectedDate = "";
let selectedTime = "";

const demoDates = [
  { label: "Fri", date: "May 1" },
  { label: "Sat", date: "May 2" },
  { label: "Tue", date: "May 5" },
  { label: "Thu", date: "May 7" },
];

const demoTimes = ["9:30 AM", "11:00 AM", "1:30 PM", "3:00 PM", "4:30 PM", "6:00 PM"];

function setStep(step) {
  currentStep = Math.min(Math.max(step, 1), 3);

  steps.forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.step) === currentStep);
  });

  progressItems.forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.progress) <= currentStep);
  });

  window.requestAnimationFrame(() => {
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function updateSummary() {
  const service = form.elements.service.value;
  const shortService = service.split(" · ")[0];
  summaryService.textContent = shortService;
  summaryTime.textContent = selectedDate && selectedTime ? `${selectedDate} at ${selectedTime}` : "Choose a time";
}

function createSlotButton(text, type, isActive = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `slot-button${isActive ? " active" : ""}`;
  button.textContent = text;
  button.dataset.slotType = type;
  return button;
}

function renderDates() {
  demoDates.forEach(({ label, date }, index) => {
    const button = createSlotButton(`${label} ${date}`, "date", index === 0);
    button.dataset.value = date;
    dateOptions.append(button);
  });
  selectedDate = demoDates[0].date;
}

function renderTimes() {
  demoTimes.forEach((time, index) => {
    const button = createSlotButton(time, "time", index === 0);
    button.dataset.value = time;
    timeOptions.append(button);
  });
  selectedTime = demoTimes[0];
}

navToggle.addEventListener("click", () => {
  const isOpen = body.classList.toggle("nav-open");
  navToggle.setAttribute("aria-expanded", String(isOpen));
});

navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    body.classList.remove("nav-open");
    navToggle.setAttribute("aria-expanded", "false");
  });
});

form.addEventListener("click", (event) => {
  const next = event.target.closest("[data-next]");
  const back = event.target.closest("[data-back]");
  const slot = event.target.closest("[data-slot-type]");

  if (next) {
    setStep(currentStep + 1);
  }

  if (back) {
    setStep(currentStep - 1);
  }

  if (slot) {
    const group = slot.dataset.slotType === "date" ? dateOptions : timeOptions;
    group.querySelectorAll(".slot-button").forEach((button) => button.classList.remove("active"));
    slot.classList.add("active");

    if (slot.dataset.slotType === "date") {
      selectedDate = slot.dataset.value;
    } else {
      selectedTime = slot.dataset.value;
    }

    updateSummary();
  }
});

form.addEventListener("change", updateSummary);

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const name = form.elements.name.value.trim();
  summaryNote.textContent = name
    ? `Thanks, ${name}. This request is staged for the future booking system.`
    : "This request is staged for the future booking system.";

  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 3600);
});

renderDates();
renderTimes();
updateSummary();
