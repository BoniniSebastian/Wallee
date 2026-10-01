import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const state = {
  user: null,
  items: [],
  activeView: "home",
  selectedCategory: "do",
  selectedStatus: "open",
  sortBy: {
    do: localStorage.getItem("wallee-sort-do") || "manual",
    think: localStorage.getItem("wallee-sort-think") || "manual",
    private: localStorage.getItem("wallee-sort-private") || "manual"
  },
  activeItemId: null,
  listScrollTop: 0,

  captureCategory: null,
  capturePriority: null,
  captureMedia: [],

  editPriority: null,
  editMedia: [],

  brainRotation: 0,
  brainAccumulated: 0,
  brainVelocity: 0,
  brainDragging: false,
  brainPointerX: 0,
  brainLastMoveAt: 0,
  brainLaps: Number(localStorage.getItem("wallee-brain-laps") || 0),
  brainLapsDirty: false,

  unsubscribeItems: null,
  unsubscribeMeta: null,

  drag: {
    active: false,
    card: null,
    pointerId: null
  }
};

const categoryConfig = {
  do: {
    label: "DO",
    color: "#62a9ff",
    rgb: "98,169,255",
    placeholder: "✓",
    yaw: -18,
    pitch: 0
  },
  think: {
    label: "THINK",
    color: "#a97dff",
    rgb: "169,125,255",
    placeholder: "⌁",
    yaw: 18,
    pitch: 0
  },
  private: {
    label: "PRIVATE",
    color: "#f4a261",
    rgb: "244,162,97",
    placeholder: "⌂",
    yaw: 0,
    pitch: 10
  }
};

const views = {
  home: $("#homeView"),
  list: $("#listView"),
  detail: $("#detailView"),
  brain: $("#brainView")
};

function uid() {
  return crypto?.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function nowISO() {
  return new Date().toISOString();
}

function jsDate(value) {
  if (!value) return new Date(0);
  if (typeof value.toDate === "function") return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function getTitle(text = "") {
  const first = String(text)
    .replace(/\r/g, "")
    .split("\n")
    .find(line => line.trim().length > 0);

  return first?.trim() || "Untitled";
}

function getBodyPreview(text = "") {
  const lines = String(text)
    .replace(/\r/g, "")
    .split("\n")
    .filter(line => line.trim().length > 0);

  return lines.slice(1).join(" ").trim() || lines[0] || "";
}

function linkifyText(text = "") {
  const urlRegex = /(https?:\/\/[^\s<]+)/gi;
  const parts = String(text).split(urlRegex);

  return parts.map(part => {
    if (/^https?:\/\//i.test(part)) {
      const safeUrl = part.replace(/["'<>]/g, "");
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(part)}</a>`;
    }
    return escapeHtml(part);
  }).join("");
}

function setAccent(category) {
  const config = categoryConfig[category] || categoryConfig.do;
  document.documentElement.style.setProperty("--accent", config.color);
  document.documentElement.style.setProperty("--accent-rgb", config.rgb);
}

function showView(name) {
  Object.values(views).forEach(view => view.classList.remove("view-active"));
  views[name].classList.add("view-active");
  state.activeView = name;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 1700);
}

/* FIREBASE */

async function loadMediaForItem(itemId) {
  const snap = await getDocs(collection(db, "walleeItems", itemId, "media"));

  return snap.docs
    .map(d => d.data())
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(media => media.dataUrl)
    .filter(Boolean);
}

async function hydrateMedia(items) {
  await Promise.all(items.map(async item => {
    try {
      item.mediaDataUrls = await loadMediaForItem(item.id);
    } catch (error) {
      console.error("Could not load item media", item.id, error);
      item.mediaDataUrls = [];
    }
  }));
}

function subscribeToItems() {
  if (state.unsubscribeItems) state.unsubscribeItems();

  const q = query(
    collection(db, "walleeItems"),
    orderBy("createdAt", "desc")
  );

  state.unsubscribeItems = onSnapshot(q, async snap => {
    const items = snap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    await hydrateMedia(items);
    state.items = items;

    renderCounts();

    if (state.activeView === "list") renderList();
    if (state.activeView === "detail") renderDetail();
  }, error => {
    console.error(error);
    showToast("Could not sync Wallee");
  });
}

function subscribeToBrainMeta() {
  if (state.unsubscribeMeta) state.unsubscribeMeta();

  state.unsubscribeMeta = onSnapshot(
    doc(db, "walleeMeta", "brain"),
    snap => {
      if (!snap.exists()) return;

      const remote = Number(snap.data().laps || 0);

      if (remote > state.brainLaps) {
        state.brainLaps = remote;
        localStorage.setItem("wallee-brain-laps", String(remote));
        renderBrainLaps();
      }
    }
  );
}

async function writeMedia(itemId, dataUrls) {
  const mediaRef = collection(db, "walleeItems", itemId, "media");
  const existing = await getDocs(mediaRef);

  await Promise.all(existing.docs.map(d =>
    deleteDoc(doc(db, "walleeItems", itemId, "media", d.id))
  ));

  await Promise.all(dataUrls.map((dataUrl, index) =>
    setDoc(
      doc(db, "walleeItems", itemId, "media", `media-${index + 1}`),
      {
        index,
        dataUrl,
        createdAt: serverTimestamp()
      }
    )
  ));
}

async function createItem({ category, text, priority, media }) {
  const id = uid();

  const manualItems = state.items.filter(item =>
    item.category === category && item.status === "open"
  );

  const highest = manualItems.reduce(
    (max, item) => Math.max(max, Number(item.sortIndex || 0)),
    0
  );

  await setDoc(doc(db, "walleeItems", id), {
    category,
    text,
    title: getTitle(text),
    priority: priority || null,
    status: "open",
    sortIndex: highest + 1000,
    comments: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    closedAt: null
  });

  if (media.length) {
    await writeMedia(id, media);
  }

  return id;
}

async function patchItem(id, patch) {
  await updateDoc(doc(db, "walleeItems", id), {
    ...patch,
    updatedAt: serverTimestamp()
  });
}

async function deleteItem(id) {
  const mediaSnap = await getDocs(collection(db, "walleeItems", id, "media"));

  await Promise.all(mediaSnap.docs.map(d =>
    deleteDoc(doc(db, "walleeItems", id, "media", d.id))
  ));

  await deleteDoc(doc(db, "walleeItems", id));
}

async function persistBrainLaps() {
  if (!state.user || !state.brainLapsDirty) return;

  state.brainLapsDirty = false;

  try {
    const ref = doc(db, "walleeMeta", "brain");
    const existing = await getDoc(ref);
    const remote = existing.exists() ? Number(existing.data().laps || 0) : 0;
    const laps = Math.max(remote, state.brainLaps);

    await setDoc(ref, {
      laps,
      updatedAt: serverTimestamp()
    }, { merge: true });

    state.brainLaps = laps;
    localStorage.setItem("wallee-brain-laps", String(laps));
    renderBrainLaps();
  } catch (error) {
    console.warn("Could not sync brain laps", error);
  }
}

/* IMAGE PROCESSING */

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function compressImage(file) {
  const source = await readFileAsDataURL(file);
  const img = await loadImage(source);

  const maxSide = 1100;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));

  let width = Math.max(1, Math.round(img.naturalWidth * scale));
  let height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  let quality = .78;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);

  while (dataUrl.length > 720_000 && quality > .42) {
    quality -= .08;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  if (dataUrl.length > 850_000) {
    width = Math.round(width * .78);
    height = Math.round(height * .78);

    const smaller = document.createElement("canvas");
    smaller.width = width;
    smaller.height = height;

    const sctx = smaller.getContext("2d", { alpha: false });
    sctx.drawImage(canvas, 0, 0, width, height);
    dataUrl = smaller.toDataURL("image/jpeg", .62);
  }

  if (dataUrl.length > 900_000) {
    throw new Error("Image is still too large after compression.");
  }

  return dataUrl;
}

/* COUNTS */

function openCount(category) {
  return state.items.filter(item =>
    item.category === category && item.status === "open"
  ).length;
}

function renderCounts() {
  const doCount = openCount("do");
  const thinkCount = openCount("think");
  const privateCount = openCount("private");

  $("#homeDoCount").textContent = doCount;
  $("#homeThinkCount").textContent = thinkCount;
  $("#homePrivateCount").textContent = privateCount;

  $("#listDoCount").textContent = doCount;
  $("#listThinkCount").textContent = thinkCount;
  $("#listPrivateCount").textContent = privateCount;
}

/* BRAIN INTERACTION */

function renderBrainTransform(immediate = false) {
  const object = $(".brain-object", $("#homeBrain"));

  if (immediate) object.style.transition = "none";
  object.style.setProperty("--brain-spin", `${state.brainRotation}deg`);

  if (immediate) {
    requestAnimationFrame(() => {
      object.style.transition = "";
    });
  }
}

function renderBrainLaps() {
  $("#brainLapCount").textContent = state.brainLaps;
}

function registerBrainRotation(delta) {
  state.brainRotation += delta;
  state.brainAccumulated += Math.abs(delta);

  while (state.brainAccumulated >= 360) {
    state.brainAccumulated -= 360;
    state.brainLaps += 1;
    state.brainLapsDirty = true;
    localStorage.setItem("wallee-brain-laps", String(state.brainLaps));
    renderBrainLaps();

    const count = $("#brainLapCount");
    count.classList.remove("tick");
    void count.offsetWidth;
    count.classList.add("tick");
  }

  renderBrainTransform(true);
}

function startBrainMomentum() {
  cancelAnimationFrame(startBrainMomentum.raf);

  const frame = () => {
    state.brainVelocity *= .955;

    if (Math.abs(state.brainVelocity) < .05) {
      state.brainVelocity = 0;
      persistBrainLaps();
      return;
    }

    registerBrainRotation(state.brainVelocity);
    startBrainMomentum.raf = requestAnimationFrame(frame);
  };

  startBrainMomentum.raf = requestAnimationFrame(frame);
}

function setBrainCategoryPose(category) {
  const config = categoryConfig[category];
  const object = $(".brain-object", $("#homeBrain"));

  setAccent(category);
  object.style.setProperty("--brain-yaw", `${config.yaw}deg`);
  object.style.setProperty("--brain-pitch", `${config.pitch}deg`);
}

function clearBrainCategoryPose() {
  const object = $(".brain-object", $("#homeBrain"));
  object.style.setProperty("--brain-yaw", "0deg");
  object.style.setProperty("--brain-pitch", "0deg");
  setAccent("do");
}

$("#homeBrain").addEventListener("pointerdown", e => {
  state.brainDragging = false;
  state.brainPointerX = e.clientX;
  state.brainLastMoveAt = performance.now();
  state.brainVelocity = 0;
  $("#homeBrain").setPointerCapture?.(e.pointerId);
});

$("#homeBrain").addEventListener("pointermove", e => {
  if (!$("#homeBrain").hasPointerCapture?.(e.pointerId)) return;

  const dx = e.clientX - state.brainPointerX;
  if (Math.abs(dx) < .5) return;

  state.brainDragging = true;
  $("#homeBrain").classList.add("brain-dragging");

  const now = performance.now();
  const dt = Math.max(8, now - state.brainLastMoveAt);
  const delta = dx * .72;

  state.brainVelocity = (delta / dt) * 16;
  state.brainPointerX = e.clientX;
  state.brainLastMoveAt = now;

  registerBrainRotation(delta);
});

$("#homeBrain").addEventListener("pointerup", e => {
  $("#homeBrain").releasePointerCapture?.(e.pointerId);
  $("#homeBrain").classList.remove("brain-dragging");

  if (state.brainDragging) {
    startBrainMomentum();
    setTimeout(() => {
      state.brainDragging = false;
    }, 40);
  } else {
    openCapture();
  }
});

$("#homeBrain").addEventListener("pointercancel", () => {
  $("#homeBrain").classList.remove("brain-dragging");
  state.brainDragging = false;
});

/* CAPTURE */

function resetCapture() {
  state.captureCategory = null;
  state.capturePriority = null;
  state.captureMedia = [];

  $("#captureText").value = "";
  renderCaptureMedia();

  $$("[data-priority]").forEach(btn => btn.classList.remove("priority-active"));

  $("#captureCategoryStep").classList.add("capture-step-active");
  $("#captureForm").classList.remove("capture-step-active");

  clearBrainCategoryPose();
}

function openCapture() {
  resetCapture();
  $("#homeView").classList.add("homeView-capturing");
  $("#capturePanel").classList.add("capture-open");
  $("#capturePanel").setAttribute("aria-hidden", "false");
}

function closeCapture() {
  $("#capturePanel").classList.remove("capture-open");
  $("#capturePanel").setAttribute("aria-hidden", "true");
  $("#homeView").classList.remove("homeView-capturing");
  clearBrainCategoryPose();
}

function chooseCaptureCategory(category) {
  state.captureCategory = category;
  state.capturePriority = null;

  const config = categoryConfig[category];

  setBrainCategoryPose(category);

  $("#captureTypeBadge").textContent = config.label;
  $("#captureCategoryStep").classList.remove("capture-step-active");
  $("#captureForm").classList.add("capture-step-active");

  setTimeout(() => $("#captureText").focus(), 220);
}

function renderCaptureMedia() {
  $("#captureMediaGrid").innerHTML = state.captureMedia.map((dataUrl, index) => `
    <div class="capture-media-thumb">
      <img src="${dataUrl}" alt="">
      <button class="capture-media-remove" type="button" data-remove-capture-media="${index}">×</button>
    </div>
  `).join("");

  $$("[data-remove-capture-media]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.captureMedia.splice(Number(btn.dataset.removeCaptureMedia), 1);
      renderCaptureMedia();
    });
  });
}

$$("[data-capture-category]").forEach(btn => {
  btn.addEventListener("click", () => chooseCaptureCategory(btn.dataset.captureCategory));
});

$("#cancelCaptureButton").addEventListener("click", closeCapture);
$("#cancelCaptureForm").addEventListener("click", closeCapture);

$("#changeCaptureCategory").addEventListener("click", () => {
  state.captureCategory = null;
  clearBrainCategoryPose();

  $("#captureForm").classList.remove("capture-step-active");
  $("#captureCategoryStep").classList.add("capture-step-active");
});

$$("[data-priority]").forEach(btn => {
  btn.addEventListener("click", () => {
    const priority = btn.dataset.priority;
    state.capturePriority = state.capturePriority === priority ? null : priority;

    $$("[data-priority]").forEach(other => {
      other.classList.toggle(
        "priority-active",
        other.dataset.priority === state.capturePriority
      );
    });
  });
});

$("#captureMediaInput").addEventListener("change", async e => {
  const files = [...e.target.files];
  const available = Math.max(0, 3 - state.captureMedia.length);

  if (!available) {
    showToast("Maximum 3 attachments");
    e.target.value = "";
    return;
  }

  try {
    showToast("Preparing images…");

    for (const file of files.slice(0, available)) {
      state.captureMedia.push(await compressImage(file));
    }

    renderCaptureMedia();
  } catch (error) {
    console.error(error);
    showToast("Could not prepare image");
  }

  e.target.value = "";
});

$("#captureForm").addEventListener("submit", async e => {
  e.preventDefault();

  const text = $("#captureText").value.trim();
  if (!state.captureCategory || !text) return;

  const button = $("#captureForm .primary-action");
  const oldText = button.textContent;

  button.disabled = true;
  button.textContent = "Saving…";

  try {
    await createItem({
      category: state.captureCategory,
      text,
      priority: state.capturePriority,
      media: state.captureMedia
    });

    const category = state.captureCategory;

    closeCapture();
    resetCapture();

    showToast(`Saved to ${categoryConfig[category].label}`);
  } catch (error) {
    console.error(error);
    showToast("Could not save item");
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
});

/* LIST NAVIGATION */

function openCategoryList(category) {
  state.selectedCategory = category;
  state.selectedStatus = "open";
  setAccent(category);
  renderListControls();
  renderList();
  showView("list");
}

$$("[data-open-category]").forEach(btn => {
  btn.addEventListener("click", () => openCategoryList(btn.dataset.openCategory));
});

$("#listHomeButton").addEventListener("click", () => {
  showView("home");
  setAccent("do");
});

$$("[data-list-category]").forEach(btn => {
  btn.addEventListener("click", () => {
    state.selectedCategory = btn.dataset.listCategory;
    state.selectedStatus = "open";
    setAccent(state.selectedCategory);
    renderListControls();
    renderList();
  });
});

$$("[data-list-status]").forEach(btn => {
  btn.addEventListener("click", () => {
    state.selectedStatus = btn.dataset.listStatus;
    renderListControls();
    renderList();
  });
});

function renderListControls() {
  $$("[data-list-category]").forEach(btn => {
    btn.classList.toggle(
      "category-tab-active",
      btn.dataset.listCategory === state.selectedCategory
    );
  });

  $$("[data-list-status]").forEach(btn => {
    btn.classList.toggle(
      "status-tab-active",
      btn.dataset.listStatus === state.selectedStatus
    );
  });

  const sort = state.sortBy[state.selectedCategory];
  $("#sortLabel").textContent = sort[0].toUpperCase() + sort.slice(1);

  $("#itemsGrid").classList.toggle(
    "manual-sort",
    sort === "manual" && state.selectedStatus === "open"
  );
}

function priorityRank(priority) {
  if (priority === "high") return 0;
  if (!priority) return 1;
  return 2;
}

function sortedItemsForList() {
  const items = state.items.filter(item =>
    item.category === state.selectedCategory &&
    item.status === state.selectedStatus
  );

  if (state.selectedStatus === "closed") {
    return items.sort((a, b) => jsDate(b.closedAt) - jsDate(a.closedAt));
  }

  const sort = state.sortBy[state.selectedCategory];

  if (sort === "priority") {
    return items.sort((a, b) => {
      const priorityDiff = priorityRank(a.priority) - priorityRank(b.priority);
      if (priorityDiff !== 0) return priorityDiff;
      return jsDate(b.createdAt) - jsDate(a.createdAt);
    });
  }

  if (sort === "newest") {
    return items.sort((a, b) => jsDate(b.createdAt) - jsDate(a.createdAt));
  }

  if (sort === "oldest") {
    return items.sort((a, b) => jsDate(a.createdAt) - jsDate(b.createdAt));
  }

  return items.sort((a, b) => {
    const sortDiff = Number(b.sortIndex || 0) - Number(a.sortIndex || 0);
    if (sortDiff !== 0) return sortDiff;
    return jsDate(b.createdAt) - jsDate(a.createdAt);
  });
}

function itemCard(item) {
  const config = categoryConfig[item.category];
  const priority = item.priority ? ` · ${item.priority.toUpperCase()}` : "";
  const preview = getBodyPreview(item.text);

  const thumb = item.mediaDataUrls?.length
    ? `<img src="${item.mediaDataUrls[0]}" alt="">`
    : `<div class="item-placeholder">${config.placeholder}</div>`;

  return `
    <article class="item-card" data-item-card="${item.id}">
      <button class="item-thumb" type="button" data-open-item="${item.id}">
        ${thumb}
      </button>

      <button class="item-copy" type="button" data-open-item="${item.id}">
        <h3>${escapeHtml(item.title || getTitle(item.text))}</h3>
        <span class="item-meta">${config.label}${priority}</span>
        <span class="item-preview">${escapeHtml(preview)}</span>
      </button>

      <div class="item-side">
        <button class="drag-handle" type="button" data-drag-handle="${item.id}" aria-label="Reorder">⠿</button>
        <button class="item-chevron" type="button" data-open-item="${item.id}">›</button>
      </div>
    </article>
  `;
}

function renderList() {
  renderCounts();
  renderListControls();

  const items = sortedItemsForList();

  $("#itemsGrid").innerHTML = items.length
    ? items.map(itemCard).join("")
    : `<div class="empty-state">${
        state.selectedStatus === "open"
          ? `No open ${categoryConfig[state.selectedCategory].label} items.`
          : `No closed ${categoryConfig[state.selectedCategory].label} items.`
      }</div>`;

  $$("[data-open-item]").forEach(btn => {
    btn.addEventListener("click", () => openDetail(btn.dataset.openItem));
  });

  setupManualDrag();
}

$("#sortButton").addEventListener("click", () => {
  $("#sheetBackdrop").classList.remove("hidden");
  $("#sortSheet").classList.remove("hidden");
});

$$("[data-sort]").forEach(btn => {
  btn.addEventListener("click", () => {
    const sort = btn.dataset.sort;

    state.sortBy[state.selectedCategory] = sort;
    localStorage.setItem(`wallee-sort-${state.selectedCategory}`, sort);

    closeSheets();
    renderList();
  });
});

/* MANUAL REORDER */

function setupManualDrag() {
  if (
    state.selectedStatus !== "open" ||
    state.sortBy[state.selectedCategory] !== "manual"
  ) return;

  $$("[data-drag-handle]").forEach(handle => {
    handle.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();

      const card = $(`[data-item-card="${handle.dataset.dragHandle}"]`);
      if (!card) return;

      state.drag.active = true;
      state.drag.card = card;
      state.drag.pointerId = e.pointerId;

      card.classList.add("dragging");
      handle.setPointerCapture?.(e.pointerId);
    });

    handle.addEventListener("pointermove", e => {
      if (!state.drag.active || state.drag.pointerId !== e.pointerId) return;

      const over = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest?.(".item-card");

      if (!over || over === state.drag.card) return;

      const grid = $("#itemsGrid");
      const cards = [...grid.querySelectorAll(".item-card")];
      const from = cards.indexOf(state.drag.card);
      const to = cards.indexOf(over);

      if (from < to) over.after(state.drag.card);
      else over.before(state.drag.card);
    });

    handle.addEventListener("pointerup", async e => {
      if (!state.drag.active || state.drag.pointerId !== e.pointerId) return;

      handle.releasePointerCapture?.(e.pointerId);
      state.drag.card?.classList.remove("dragging");

      const order = [...$("#itemsGrid").querySelectorAll(".item-card")]
        .map(card => card.dataset.itemCard);

      state.drag.active = false;
      state.drag.card = null;
      state.drag.pointerId = null;

      try {
        await Promise.all(order.map((id, index) =>
          patchItem(id, {
            sortIndex: (order.length - index) * 1000
          })
        ));
      } catch (error) {
        console.error(error);
        showToast("Could not save order");
      }
    });

    handle.addEventListener("pointercancel", () => {
      state.drag.card?.classList.remove("dragging");
      state.drag.active = false;
      state.drag.card = null;
      state.drag.pointerId = null;
    });
  });
}

/* DETAIL */

function activeItem() {
  return state.items.find(item => item.id === state.activeItemId);
}

function openDetail(id) {
  state.activeItemId = id;
  state.listScrollTop = $("#itemsGrid").scrollTop;
  renderDetail();
  showView("detail");
}

function renderDetail() {
  const item = activeItem();
  if (!item) return;

  setAccent(item.category);

  const config = categoryConfig[item.category];

  $("#detailTypeBadge").textContent = config.label;
  $("#detailTitle").textContent = item.title || getTitle(item.text);
  $("#detailText").innerHTML = linkifyText(item.text || "");

  $("#detailPriority").classList.toggle("hidden", !item.priority);
  $("#detailPriority").textContent = item.priority?.toUpperCase() || "";

  const media = item.mediaDataUrls || [];

  $("#detailMedia").classList.toggle("hidden", !media.length);
  $("#detailMedia").innerHTML = media
    .map(src => `<img src="${src}" alt="">`)
    .join("");

  const comments = item.comments || [];
  $("#commentCount").textContent = comments.length;

  $("#commentList").innerHTML = comments.length
    ? comments.map(comment =>
        `<div class="comment-item">${escapeHtml(comment.text)}</div>`
      ).join("")
    : "";

  $("#detailCloseButton").textContent =
    item.status === "closed" ? "Reopen" : "Close";
}

$("#detailBackButton").addEventListener("click", () => {
  showView("list");
  setAccent(state.selectedCategory);

  requestAnimationFrame(() => {
    $("#itemsGrid").scrollTop = state.listScrollTop;
  });
});

$("#detailEditButton").addEventListener("click", openEditSheet);
$("#editTextInlineButton").addEventListener("click", openEditSheet);

$("#detailCloseButton").addEventListener("click", async () => {
  const item = activeItem();
  if (!item) return;

  const closing = item.status !== "closed";

  await patchItem(item.id, {
    status: closing ? "closed" : "open",
    closedAt: closing ? serverTimestamp() : null
  });

  state.selectedStatus = closing ? "open" : "closed";

  showView("list");
  setAccent(state.selectedCategory);
  showToast(closing ? "Closed" : "Reopened");
});

$("#addCommentButton").addEventListener("click", async () => {
  const item = activeItem();
  const input = $("#commentInput");
  const text = input.value.trim();

  if (!item || !text) return;

  const comments = [
    ...(item.comments || []),
    {
      id: uid(),
      text,
      createdAt: nowISO()
    }
  ];

  await patchItem(item.id, { comments });
  input.value = "";
});

$("#commentInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#addCommentButton").click();
  }
});

/* EDIT SHEET */

function openEditSheet() {
  const item = activeItem();
  if (!item) return;

  state.editPriority = item.priority || null;
  state.editMedia = [...(item.mediaDataUrls || [])];

  $("#editText").value = item.text || "";

  renderEditPriority();
  renderEditMedia();

  $("#sheetBackdrop").classList.remove("hidden");
  $("#editSheet").classList.remove("hidden");
}

function renderEditPriority() {
  $$("[data-edit-priority]").forEach(btn => {
    btn.classList.toggle(
      "priority-active",
      btn.dataset.editPriority === state.editPriority
    );
  });
}

function renderEditMedia() {
  $("#editMediaGrid").innerHTML = state.editMedia.map((src, index) => `
    <div class="capture-media-thumb">
      <img src="${src}" alt="">
      <button class="capture-media-remove" type="button" data-remove-edit-media="${index}">×</button>
    </div>
  `).join("");

  $$("[data-remove-edit-media]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.editMedia.splice(Number(btn.dataset.removeEditMedia), 1);
      renderEditMedia();
    });
  });
}

$$("[data-edit-priority]").forEach(btn => {
  btn.addEventListener("click", () => {
    const priority = btn.dataset.editPriority;

    state.editPriority =
      state.editPriority === priority ? null : priority;

    renderEditPriority();
  });
});

$("#editMediaInput").addEventListener("change", async e => {
  const files = [...e.target.files];
  const available = Math.max(0, 3 - state.editMedia.length);

  if (!available) {
    showToast("Maximum 3 attachments");
    e.target.value = "";
    return;
  }

  try {
    for (const file of files.slice(0, available)) {
      state.editMedia.push(await compressImage(file));
    }

    renderEditMedia();
  } catch (error) {
    console.error(error);
    showToast("Could not prepare image");
  }

  e.target.value = "";
});

$("#saveEditButton").addEventListener("click", async () => {
  const item = activeItem();
  const text = $("#editText").value.trim();

  if (!item || !text) return;

  const button = $("#saveEditButton");
  button.disabled = true;

  try {
    await patchItem(item.id, {
      text,
      title: getTitle(text),
      priority: state.editPriority || null
    });

    await writeMedia(item.id, state.editMedia);

    closeSheets();
    showToast("Updated");
  } catch (error) {
    console.error(error);
    showToast("Could not update");
  } finally {
    button.disabled = false;
  }
});

$("#cancelEditButton").addEventListener("click", closeSheets);

$("#deleteItemButton").addEventListener("click", async () => {
  const item = activeItem();
  if (!item) return;

  if (!confirm("Delete this item? This can’t be undone.")) return;

  await deleteItem(item.id);

  closeSheets();
  showView("list");
  showToast("Deleted");
});

/* BRAIN SPACE */

$("#brainPageButton").addEventListener("click", () => {
  showView("brain");
});

$("#closeBrainPage").addEventListener("click", () => {
  showView("list");
  setAccent(state.selectedCategory);
});

$(".brain-space-brain").addEventListener("click", () => {
  showView("list");
  setAccent(state.selectedCategory);
});

/* SHEETS */

function closeSheets() {
  $("#sheetBackdrop").classList.add("hidden");
  $("#editSheet").classList.add("hidden");
  $("#sortSheet").classList.add("hidden");
}

$("#sheetBackdrop").addEventListener("click", closeSheets);

/* LOCK APP SHELL */

document.addEventListener("touchmove", e => {
  if (!e.target.closest(
    ".scroll-zone, .capture-panel, .detail-media, .bottom-sheet"
  )) {
    e.preventDefault();
  }
}, { passive:false });

/* SERVICE WORKER */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(console.warn);
  });
}

/* AUTH */

onAuthStateChanged(auth, async user => {
  state.user = user;

  if (user) {
    subscribeToItems();
    subscribeToBrainMeta();
    renderCounts();
    renderBrainLaps();
    return;
  }

  try {
    await signInAnonymously(auth);
  } catch (error) {
    console.error("Anonymous Firebase sign-in failed", error);
    showToast("Firebase connection unavailable");
  }
});

renderBrainLaps();
renderListControls();
