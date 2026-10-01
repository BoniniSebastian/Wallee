import { firebaseConfig } from "./firebase-config.js";
import { createLivingCube } from "./cube.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const categoryConfig = {
  content: { label: "CONTENT", color: "#d8dbe2", rgb: "188,197,214" },
  do: { label: "DO", color: "#8db8ff", rgb: "141,184,255" },
  think: { label: "THINK", color: "#c3a4ff", rgb: "195,164,255" },
  private: { label: "PRIVATE", color: "#ff9fa7", rgb: "255,159,167" }
};

const state = {
  user: null,
  items: [],
  activeView: "home",
  selectedCategory: "content",
  selectedStatus: "open",
  sortBy: {
    content: localStorage.getItem("wallee-sort-content") || "manual",
    do: localStorage.getItem("wallee-sort-do") || "manual",
    think: localStorage.getItem("wallee-sort-think") || "manual",
    private: localStorage.getItem("wallee-sort-private") || "manual"
  },
  activeItemId: null,
  listScrollTop: 0,
  captureCategory: null,
  capturePriority: null,
  captureMedia: [],
  captureOrigin: "home",
  editPriority: null,
  editMedia: [],
  unsubscribeItems: null,
  drag: { active: false, card: null, pointerId: null }
};

const views = {
  home: $("#homeView"),
  list: $("#listView"),
  detail: $("#detailView"),
  future: $("#futureView")
};

const homeCube = createLivingCube($("#homeCubeCanvas"), { phaseSeed: 0.4 });
createLivingCube($("#futureCubeCanvas"), { phaseSeed: 2.1 });

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
  return String(text).split(urlRegex).map(part => {
    if (/^https?:\/\//i.test(part)) {
      const safeUrl = part.replace(/["'<>]/g, "");
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(part)}</a>`;
    }
    return escapeHtml(part);
  }).join("");
}

function setAccent(category) {
  const config = categoryConfig[category] || categoryConfig.content;
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
      console.error("Could not load media", item.id, error);
      item.mediaDataUrls = [];
    }
  }));
}

function subscribeToItems() {
  if (state.unsubscribeItems) state.unsubscribeItems();

  const q = query(collection(db, "walleeItems"), orderBy("createdAt", "desc"));

  state.unsubscribeItems = onSnapshot(q, async snap => {
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

async function writeMedia(itemId, dataUrls) {
  const mediaRef = collection(db, "walleeItems", itemId, "media");
  const existing = await getDocs(mediaRef);

  await Promise.all(existing.docs.map(d =>
    deleteDoc(doc(db, "walleeItems", itemId, "media", d.id))
  ));

  await Promise.all(dataUrls.map((dataUrl, index) =>
    setDoc(doc(db, "walleeItems", itemId, "media", `media-${index + 1}`), {
      index,
      dataUrl,
      createdAt: serverTimestamp()
    })
  ));
}

async function createItem({ category, text, priority, media }) {
  const id = uid();
  const peers = state.items.filter(item => item.category === category && item.status === "open");
  const highest = peers.reduce((max, item) => Math.max(max, Number(item.sortIndex || 0)), 0);

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

  if (media.length) await writeMedia(id, media);
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
  while (dataUrl.length > 720000 && quality > .42) {
    quality -= .08;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  if (dataUrl.length > 850000) {
    width = Math.round(width * .78);
    height = Math.round(height * .78);
    const smaller = document.createElement("canvas");
    smaller.width = width;
    smaller.height = height;
    const sctx = smaller.getContext("2d", { alpha: false });
    sctx.drawImage(canvas, 0, 0, width, height);
    dataUrl = smaller.toDataURL("image/jpeg", .62);
  }

  if (dataUrl.length > 900000) throw new Error("Image is still too large after compression.");
  return dataUrl;
}

function iconMarkup(category, { mini = false } = {}) {
  if (category === "content") {
    return mini
      ? `<span class="mini-instagram"></span>`
      : `<span class="category-icon instagram-icon"><span class="instagram-camera"></span></span>`;
  }

  const cls = mini ? "line-icon" : "category-icon line-icon";
  if (category === "do") {
    return `<span class="${cls}"><svg viewBox="0 0 64 64"><path d="M39 10l15 15-8 8-4-4-19 19-7 2 2-7 19-19-5-5z"/></svg></span>`;
  }
  if (category === "think") {
    return `<span class="${cls}"><svg viewBox="0 0 64 64"><path d="M31 11c-7-7-18-1-16 8-9 1-11 13-3 18-6 8 2 18 11 15 3 7 13 7 17 1 6 6 16 3 17-5 8-3 9-15 2-19 4-10-8-17-16-12-2-8-12-11-18-6z"/><path d="M31 14v36"/></svg></span>`;
  }
  return `<span class="${cls}"><svg viewBox="0 0 64 64"><path d="M32 53S10 40 10 23c0-8 10-13 17-7l5 5 5-5c7-6 17-1 17 7 0 17-22 30-22 30z"/></svg></span>`;
}

function openCount(category) {
  return state.items.filter(item => item.category === category && item.status === "open").length;
}

function setBadge(selector, value) {
  const el = $(selector);
  el.textContent = value;
  el.classList.toggle("hidden", value === 0);
}

function renderCounts() {
  const counts = {
    content: openCount("content"),
    do: openCount("do"),
    think: openCount("think"),
    private: openCount("private")
  };
  setBadge("#homeContentCount", counts.content);
  setBadge("#homeDoCount", counts.do);
  setBadge("#homeThinkCount", counts.think);
  setBadge("#homePrivateCount", counts.private);
  if (state.activeView === "list") $("#listIdentityCount").textContent = counts[state.selectedCategory];
}

function resetCapture() {
  state.captureCategory = null;
  state.capturePriority = null;
  state.captureMedia = [];
  $("#captureText").value = "";
  renderCaptureMedia();
  $$('[data-priority]').forEach(btn => btn.classList.remove("priority-active"));
  $("#captureCategoryStep").classList.add("capture-step-active");
  $("#captureForm").classList.remove("capture-step-active");
  $("#changeCaptureCategory").classList.remove("hidden");
}

function openCapture(category = null, origin = "home") {
  state.captureOrigin = origin;
  resetCapture();
  $("#captureBackdrop").classList.remove("hidden");
  $("#captureOverlay").classList.remove("hidden");
  if (category) chooseCaptureCategory(category, { lockCategory: origin === "list" });
}

function closeCapture() {
  $("#captureBackdrop").classList.add("hidden");
  $("#captureOverlay").classList.add("hidden");
  setAccent(state.activeView === "list" ? state.selectedCategory : "content");
}

function chooseCaptureCategory(category, { lockCategory = false } = {}) {
  state.captureCategory = category;
  state.capturePriority = null;
  setAccent(category);
  $("#captureTypeBadge").textContent = categoryConfig[category].label;
  $("#captureCategoryStep").classList.remove("capture-step-active");
  $("#captureForm").classList.add("capture-step-active");
  $("#changeCaptureCategory").classList.toggle("hidden", lockCategory);
  setTimeout(() => $("#captureText").focus(), 180);
}

function renderCaptureMedia() {
  $("#captureMediaGrid").innerHTML = state.captureMedia.map((src, index) => `
    <div class="capture-media-thumb">
      <img src="${src}" alt="">
      <button class="capture-media-remove" type="button" data-remove-capture-media="${index}">×</button>
    </div>`).join("");

  $$('[data-remove-capture-media]').forEach(btn => {
    btn.addEventListener("click", () => {
      state.captureMedia.splice(Number(btn.dataset.removeCaptureMedia), 1);
      renderCaptureMedia();
    });
  });
}

$("#homeCubeButton").addEventListener("click", () => openCapture(null, "home"));
$$('[data-capture-category]').forEach(btn => btn.addEventListener("click", () => chooseCaptureCategory(btn.dataset.captureCategory)));
$("#cancelCaptureButton").addEventListener("click", closeCapture);
$("#cancelCaptureForm").addEventListener("click", closeCapture);
$("#captureBackdrop").addEventListener("click", closeCapture);
$("#changeCaptureCategory").addEventListener("click", () => {
  state.captureCategory = null;
  $("#captureForm").classList.remove("capture-step-active");
  $("#captureCategoryStep").classList.add("capture-step-active");
  $("#changeCaptureCategory").classList.remove("hidden");
});

$$('[data-priority]').forEach(btn => {
  btn.addEventListener("click", () => {
    const priority = btn.dataset.priority;
    state.capturePriority = state.capturePriority === priority ? null : priority;
    $$('[data-priority]').forEach(other => other.classList.toggle("priority-active", other.dataset.priority === state.capturePriority));
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
    for (const file of files.slice(0, available)) state.captureMedia.push(await compressImage(file));
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
    const category = state.captureCategory;
    await createItem({ category, text, priority: state.capturePriority, media: state.captureMedia });
    homeCube.pulse?.();
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

$$('[data-open-category]').forEach(btn => btn.addEventListener("click", () => openCategoryList(btn.dataset.openCategory)));

function openCategoryList(category) {
  state.selectedCategory = category;
  state.selectedStatus = "open";
  setAccent(category);
  renderListControls();
  renderList();
  showView("list");
}

$("#listHomeButton").addEventListener("click", () => {
  showView("home");
  setAccent("content");
});

$("#listAddButton").addEventListener("click", () => openCapture(state.selectedCategory, "list"));
$("#futureSpaceButton").addEventListener("click", () => showView("future"));
$("#closeFutureButton").addEventListener("click", () => {
  showView("list");
  setAccent(state.selectedCategory);
});

$$('[data-list-category]').forEach(btn => {
  btn.addEventListener("click", () => {
    state.selectedCategory = btn.dataset.listCategory;
    state.selectedStatus = "open";
    setAccent(state.selectedCategory);
    renderListControls();
    renderList();
  });
});

$$('[data-list-status]').forEach(btn => {
  btn.addEventListener("click", () => {
    state.selectedStatus = btn.dataset.listStatus;
    renderListControls();
    renderList();
  });
});

function renderListIdentity() {
  $("#listIdentityCount").textContent = openCount(state.selectedCategory);
  $("#listIdentityIcon").innerHTML = iconMarkup(state.selectedCategory);
}

function renderListControls() {
  $$('[data-list-category]').forEach(btn => btn.classList.toggle("active", btn.dataset.listCategory === state.selectedCategory));
  $$('[data-list-status]').forEach(btn => btn.classList.toggle("status-tab-active", btn.dataset.listStatus === state.selectedStatus));
  $("#itemsGrid").classList.toggle("manual-sort", state.selectedStatus === "open" && state.sortBy[state.selectedCategory] === "manual");
  renderListIdentity();
}

function priorityRank(priority) {
  if (priority === "high") return 0;
  if (!priority) return 1;
  return 2;
}

function sortedItemsForList() {
  const items = state.items.filter(item => item.category === state.selectedCategory && item.status === state.selectedStatus);
  if (state.selectedStatus === "closed") return items.sort((a, b) => jsDate(b.closedAt) - jsDate(a.closedAt));

  const sort = state.sortBy[state.selectedCategory];
  if (sort === "priority") {
    return items.sort((a, b) => {
      const d = priorityRank(a.priority) - priorityRank(b.priority);
      return d !== 0 ? d : jsDate(b.createdAt) - jsDate(a.createdAt);
    });
  }
  if (sort === "newest") return items.sort((a, b) => jsDate(b.createdAt) - jsDate(a.createdAt));
  if (sort === "oldest") return items.sort((a, b) => jsDate(a.createdAt) - jsDate(b.createdAt));

  return items.sort((a, b) => {
    const d = Number(b.sortIndex || 0) - Number(a.sortIndex || 0);
    return d !== 0 ? d : jsDate(b.createdAt) - jsDate(a.createdAt);
  });
}

function placeholderMarkup(category) {
  return `<div class="item-placeholder">${iconMarkup(category, { mini: true })}</div>`;
}

function itemCard(item) {
  const config = categoryConfig[item.category];
  const priority = item.priority ? ` · ${item.priority.toUpperCase()}` : "";
  const preview = getBodyPreview(item.text);
  const thumb = item.mediaDataUrls?.length
    ? `<img src="${item.mediaDataUrls[0]}" alt="">`
    : placeholderMarkup(item.category);

  return `<article class="item-card" data-item-card="${item.id}">
    <button class="item-thumb" type="button" data-open-item="${item.id}">${thumb}</button>
    <button class="item-copy" type="button" data-open-item="${item.id}">
      <h3>${escapeHtml(item.title || getTitle(item.text))}</h3>
      <span class="item-meta">${config.label}${priority}</span>
      <span class="item-preview">${escapeHtml(preview)}</span>
    </button>
    <div class="item-side">
      <button class="drag-handle" type="button" data-drag-handle="${item.id}" aria-label="Reorder">⠿</button>
      <button class="item-chevron" type="button" data-open-item="${item.id}">›</button>
    </div>
  </article>`;
}

function renderList() {
  renderCounts();
  renderListControls();
  const items = sortedItemsForList();
  $("#itemsGrid").innerHTML = items.length
    ? items.map(itemCard).join("")
    : `<div class="empty-state">${state.selectedStatus === "open" ? "Nothing here yet." : "Nothing closed yet."}</div>`;
  $$('[data-open-item]').forEach(btn => btn.addEventListener("click", () => openDetail(btn.dataset.openItem)));
  setupManualDrag();
}

$("#sortButton").addEventListener("click", () => {
  $("#sheetBackdrop").classList.remove("hidden");
  $("#sortSheet").classList.remove("hidden");
});

$$('[data-sort]').forEach(btn => {
  btn.addEventListener("click", () => {
    const sort = btn.dataset.sort;
    state.sortBy[state.selectedCategory] = sort;
    localStorage.setItem(`wallee-sort-${state.selectedCategory}`, sort);
    closeSheets();
    renderList();
  });
});

function setupManualDrag() {
  if (state.selectedStatus !== "open" || state.sortBy[state.selectedCategory] !== "manual") return;

  $$('[data-drag-handle]').forEach(handle => {
    handle.addEventListener("pointerdown", e => {
      e.preventDefault();
      e.stopPropagation();
      const card = $(`[data-item-card="${handle.dataset.dragHandle}"]`);
      if (!card) return;
      state.drag = { active: true, card, pointerId: e.pointerId };
      card.classList.add("dragging");
      handle.setPointerCapture?.(e.pointerId);
    });

    handle.addEventListener("pointermove", e => {
      if (!state.drag.active || state.drag.pointerId !== e.pointerId) return;
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".item-card");
      if (!over || over === state.drag.card) return;
      const cards = [...$("#itemsGrid").querySelectorAll(".item-card")];
      const from = cards.indexOf(state.drag.card);
      const to = cards.indexOf(over);
      if (from < to) over.after(state.drag.card);
      else over.before(state.drag.card);
    });

    handle.addEventListener("pointerup", async e => {
      if (!state.drag.active || state.drag.pointerId !== e.pointerId) return;
      handle.releasePointerCapture?.(e.pointerId);
      state.drag.card?.classList.remove("dragging");
      const order = [...$("#itemsGrid").querySelectorAll(".item-card")].map(card => card.dataset.itemCard);
      state.drag = { active: false, card: null, pointerId: null };
      try {
        await Promise.all(order.map((id, index) => patchItem(id, { sortIndex: (order.length - index) * 1000 })));
      } catch (error) {
        console.error(error);
        showToast("Could not save order");
      }
    });

    handle.addEventListener("pointercancel", () => {
      state.drag.card?.classList.remove("dragging");
      state.drag = { active: false, card: null, pointerId: null };
    });
  });
}

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
  $("#detailMedia").innerHTML = media.map(src => `<img src="${src}" alt="">`).join("");
  const comments = item.comments || [];
  $("#commentCount").textContent = comments.length;
  $("#commentList").innerHTML = comments.map(comment => `<div class="comment-item">${escapeHtml(comment.text)}</div>`).join("");
  $("#detailCloseButton").textContent = item.status === "closed" ? "Reopen" : "Close";
}

$("#detailBackButton").addEventListener("click", () => {
  showView("list");
  setAccent(state.selectedCategory);
  requestAnimationFrame(() => { $("#itemsGrid").scrollTop = state.listScrollTop; });
});

$("#detailEditButton").addEventListener("click", openEditSheet);
$("#editTextInlineButton").addEventListener("click", openEditSheet);

$("#detailCloseButton").addEventListener("click", async () => {
  const item = activeItem();
  if (!item) return;
  const closing = item.status !== "closed";
  await patchItem(item.id, { status: closing ? "closed" : "open", closedAt: closing ? serverTimestamp() : null });
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
  const comments = [...(item.comments || []), { id: uid(), text, createdAt: nowISO() }];
  await patchItem(item.id, { comments });
  input.value = "";
});

$("#commentInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#addCommentButton").click();
  }
});

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
  $$('[data-edit-priority]').forEach(btn => btn.classList.toggle("priority-active", btn.dataset.editPriority === state.editPriority));
}

function renderEditMedia() {
  $("#editMediaGrid").innerHTML = state.editMedia.map((src, index) => `
    <div class="capture-media-thumb">
      <img src="${src}" alt="">
      <button class="capture-media-remove" type="button" data-remove-edit-media="${index}">×</button>
    </div>`).join("");

  $$('[data-remove-edit-media]').forEach(btn => {
    btn.addEventListener("click", () => {
      state.editMedia.splice(Number(btn.dataset.removeEditMedia), 1);
      renderEditMedia();
    });
  });
}

$$('[data-edit-priority]').forEach(btn => {
  btn.addEventListener("click", () => {
    const priority = btn.dataset.editPriority;
    state.editPriority = state.editPriority === priority ? null : priority;
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
    for (const file of files.slice(0, available)) state.editMedia.push(await compressImage(file));
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
    await patchItem(item.id, { text, title: getTitle(text), priority: state.editPriority || null });
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

function closeSheets() {
  $("#sheetBackdrop").classList.add("hidden");
  $("#editSheet").classList.add("hidden");
  $("#sortSheet").classList.add("hidden");
}

$("#sheetBackdrop").addEventListener("click", closeSheets);

document.addEventListener("touchmove", e => {
  if (!e.target.closest(".scroll-zone, .capture-overlay, .detail-media, .bottom-sheet")) e.preventDefault();
}, { passive: false });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.warn));
}

onAuthStateChanged(auth, async user => {
  state.user = user;
  if (user) {
    subscribeToItems();
    renderCounts();
    return;
  }
  try {
    await signInAnonymously(auth);
  } catch (error) {
    console.error("Anonymous Firebase sign-in failed", error);
    showToast("Firebase connection unavailable");
  }
});

setAccent("content");
renderCounts();
renderListControls();
