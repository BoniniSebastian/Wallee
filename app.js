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
  posts: [],
  mediaDraft: [],
  editorType: "post",
  approvalIds: [],
  approvalIndex: 0,
  approvedTab: "ready",
  activePostId: null,
  unsubscribePosts: null,
  user: null
};

const DRAFT_KEY = "wallee-approval-draft-v2";

const views = {
  home: $("#homeView"),
  editor: $("#editorView"),
  pending: $("#pendingView"),
  approval: $("#approvalView"),
  approved: $("#approvedView")
};

function uid() {
  return crypto?.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatApprovalDate(value) {
  if (!value) return "";

  let d;
  if (value?.toDate) d = value.toDate();
  else d = new Date(value);

  if (Number.isNaN(d.getTime())) return "";

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d).replace(",", " ·");
}

function jsDate(value) {
  if (!value) return new Date(0);
  if (value?.toDate) return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function showView(name) {
  Object.values(views).forEach(v => v.classList.remove("view-active"));
  views[name].classList.add("view-active");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 1800);
}


function saveDraftLocal() {
  const draft = {
    account: $("#accountInput").value,
    type: state.editorType,
    totalImages: $("#totalImagesInput").value,
    caption: $("#captionInput").value,
    note: $("#noteInput").value
  };
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

function restoreDraftLocal() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (!draft) return;

    $("#accountInput").value = draft.account || "";
    $("#totalImagesInput").value = draft.totalImages || "";
    $("#captionInput").value = draft.caption || "";
    $("#noteInput").value = draft.note || "";
    setEditorType(draft.type || "post");
  } catch {}
}

function clearDraftLocal() {
  localStorage.removeItem(DRAFT_KEY);
}

async function compressImage(file, type) {
  const source = await readFileAsDataURL(file);
  const img = await loadImage(source);

  const targetRatio = type === "reel" ? 9 / 16 : 4 / 5;
  const maxW = type === "reel" ? 900 : 900;
  const maxH = type === "reel" ? 1600 : 1125;

  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  const sourceRatio = sw / sh;

  if (sourceRatio > targetRatio) {
    sw = sh * targetRatio;
    sx = (img.naturalWidth - sw) / 2;
  } else if (sourceRatio < targetRatio) {
    sh = sw / targetRatio;
    sy = (img.naturalHeight - sh) / 2;
  }

  let outW = Math.min(maxW, sw);
  let outH = Math.round(outW / targetRatio);

  if (outH > maxH) {
    outH = maxH;
    outW = Math.round(outH * targetRatio);
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(outW));
  canvas.height = Math.max(1, Math.round(outH));

  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  let quality = 0.78;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);

  // Keep generous distance from Firestore's 1 MiB document limit.
  while (dataUrl.length > 720_000 && quality > 0.42) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  if (dataUrl.length > 850_000) {
    const scale = 0.8;
    const smaller = document.createElement("canvas");
    smaller.width = Math.round(canvas.width * scale);
    smaller.height = Math.round(canvas.height * scale);
    const sctx = smaller.getContext("2d", { alpha: false });
    sctx.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    dataUrl = smaller.toDataURL("image/jpeg", 0.62);
  }

  if (dataUrl.length > 900_000) {
    throw new Error("Image could not be compressed enough.");
  }

  return dataUrl;
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

async function loadMediaForPost(postId) {
  const snap = await getDocs(collection(db, "approvalPosts", postId, "media"));
  return snap.docs
    .map(d => d.data())
    .sort((a,b) => (a.index ?? 0) - (b.index ?? 0))
    .map(item => item.dataUrl)
    .filter(Boolean);
}

async function loadAllMedia(posts) {
  await Promise.all(posts.map(async post => {
    try {
      post.mediaDataUrls = await loadMediaForPost(post.id);
    } catch (error) {
      console.error("Could not load media for", post.id, error);
      post.mediaDataUrls = [];
    }
  }));
}

function subscribeToPosts() {
  if (state.unsubscribePosts) state.unsubscribePosts();

  const q = query(
    collection(db, "approvalPosts"),
    orderBy("createdAt", "desc")
  );

  state.unsubscribePosts = onSnapshot(q, async snap => {
    const posts = snap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    await loadAllMedia(posts);
    state.posts = posts;
    renderAll();

    // Keep approval screen fresh if another device edits the active item.
    if (views.approval.classList.contains("view-active")) {
      renderApproval();
    }
  }, error => {
    console.error(error);
    showToast("Could not load posts");
  });
}

async function writeMedia(postId, dataUrls) {
  const existing = await getDocs(collection(db, "approvalPosts", postId, "media"));

  await Promise.all(existing.docs.map(d =>
    deleteDoc(doc(db, "approvalPosts", postId, "media", d.id))
  ));

  await Promise.all(dataUrls.map((dataUrl, index) =>
    setDoc(
      doc(db, "approvalPosts", postId, "media", `media-${index + 1}`),
      {
        index,
        dataUrl,
        createdAt: serverTimestamp()
      }
    )
  ));
}

async function persistPost(post, mediaDataUrls) {
  const postRef = doc(db, "approvalPosts", post.id);

  await setDoc(postRef, {
    account: post.account,
    type: post.type,
    totalImages: post.totalImages,
    caption: post.caption,
    note: post.note,
    status: "pending",
    comments: post.comments || [],
    postedLive: false,
    approvedAt: null,
    postedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: state.user?.uid || null,
    createdByEmail: state.user?.email || null
  });

  await writeMedia(post.id, mediaDataUrls);
}

async function patchPost(id, patch) {
  await updateDoc(doc(db, "approvalPosts", id), {
    ...patch,
    updatedAt: serverTimestamp()
  });
}

async function removePost(id) {
  const mediaSnap = await getDocs(collection(db, "approvalPosts", id, "media"));
  await Promise.all(mediaSnap.docs.map(d =>
    deleteDoc(doc(db, "approvalPosts", id, "media", d.id))
  ));

  await deleteDoc(doc(db, "approvalPosts", id));
}

function renderCounts() {
  const pending = state.posts.filter(p => p.status === "pending").length;
  const approved = state.posts.filter(p => p.status === "approved").length;

  $("#pendingCount").textContent = pending;
  $("#pendingHeaderCount").textContent = pending;
  $("#approvedCount").textContent = approved;
  $("#approvedHeaderCount").textContent = approved;
}

function firstMedia(post) {
  return post.mediaDataUrls?.[0] || "./Assets/media-placeholder.svg";
}

function pendingCard(post) {
  const meta = post.type === "reel"
    ? "Reel"
    : `Post · ${post.totalImages || post.mediaDataUrls?.length || 1} images`;

  return `
    <button class="list-card" data-open-pending="${post.id}">
      <img class="list-thumb ${post.type === "reel" ? "reel" : ""}" src="${firstMedia(post)}" alt="" />
      <span class="list-copy">
        <strong>${escapeHtml(post.account)}</strong>
        <small>${meta}</small>
        <span class="list-caption">${escapeHtml(post.caption || "")}</span>
      </span>
      <span class="chevron">›</span>
    </button>
  `;
}

function renderPending() {
  const pendingPosts = state.posts
    .filter(p => p.status === "pending")
    .sort((a,b) => jsDate(b.createdAt) - jsDate(a.createdAt));

  $("#pendingList").innerHTML = pendingPosts.length
    ? pendingPosts.map(pendingCard).join("")
    : `<div class="empty-state">Nothing is waiting for approval.</div>`;

  $$("[data-open-pending]").forEach(btn => {
    btn.addEventListener("click", () => openApproval(btn.dataset.openPending));
  });
}

function approvedCard(post) {
  const checked = !!post.postedLive;
  const meta = post.type === "reel"
    ? "Reel"
    : `Post · ${post.totalImages || post.mediaDataUrls?.length || 1} images`;

  const statusLine = checked
    ? `Posted live ${formatApprovalDate(post.postedAt)}`
    : `Approved ${formatApprovalDate(post.approvedAt)}`;

  return `
    <div class="list-card approved-card">
      <button class="posted-checkbox ${checked ? "checked" : ""}" data-toggle-posted="${post.id}" aria-label="Posted live">
        ${checked ? "✓" : ""}
      </button>
      <img class="list-thumb ${post.type === "reel" ? "reel" : ""}" src="${firstMedia(post)}" alt="" />
      <button class="list-copy approved-open" data-open-approved="${post.id}">
        <strong>${escapeHtml(post.account)}</strong>
        <small>${meta}</small>
        <span class="list-caption">${escapeHtml(post.caption || "")}</span>
        <span class="approved-status">${statusLine}</span>
      </button>
      <button class="icon-button approved-open" data-open-approved="${post.id}">›</button>
    </div>
  `;
}

function renderApproved() {
  let posts = state.posts
    .filter(p => p.status === "approved")
    .sort((a,b) => jsDate(b.approvedAt || b.updatedAt) - jsDate(a.approvedAt || a.updatedAt));

  posts = posts.filter(p =>
    state.approvedTab === "posted" ? p.postedLive : !p.postedLive
  );

  $("#approvedList").innerHTML = posts.length
    ? posts.map(approvedCard).join("")
    : `<div class="empty-state">${
        state.approvedTab === "posted"
          ? "No posts marked live yet."
          : "No approved posts waiting to go live."
      }</div>`;

  $$("[data-toggle-posted]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const post = state.posts.find(p => p.id === btn.dataset.togglePosted);
      if (!post) return;

      const next = !post.postedLive;

      await patchPost(post.id, {
        postedLive: next,
        postedAt: next ? serverTimestamp() : null
      });

      showToast(next ? "Marked Posted live" : "Moved back to Ready");
    });
  });

  $$("[data-open-approved]").forEach(btn => {
    btn.addEventListener("click", () => openStatusSheet(btn.dataset.openApproved));
  });
}

function renderAll() {
  renderCounts();
  renderPending();
  renderApproved();
}

function setEditorType(type) {
  state.editorType = type;

  $$(".segment").forEach(btn =>
    btn.classList.toggle("segment-active", btn.dataset.type === type)
  );

  const isReel = type === "reel";
  $("#totalImagesGroup").classList.toggle("hidden", isReel);
  $("#mediaLabel").textContent = isReel ? "Reel cover" : "Preview images";
  $("#mediaHint").textContent = isReel ? "1 screenshot" : "Max 3 images";
  $("#mediaInput").multiple = !isReel;

  if (isReel && state.mediaDraft.length > 1) {
    state.mediaDraft = state.mediaDraft.slice(0,1);
  }

  renderDraftMedia();
}

function renderDraftMedia() {
  const isReel = state.editorType === "reel";
  const items = isReel ? state.mediaDraft.slice(0,1) : state.mediaDraft.slice(0,3);

  $("#mediaGrid").innerHTML = items.map((item,index) => `
    <div class="media-thumb ${isReel ? "reel" : ""}">
      <img src="${item.dataUrl}" alt="Preview ${index + 1}" />
      <button type="button" class="remove-media" data-remove-media="${index}">×</button>
    </div>
  `).join("");

  $$("[data-remove-media]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.mediaDraft.splice(Number(btn.dataset.removeMedia),1);
      renderDraftMedia();
    });
  });
}

function resetEditor() {
  state.mediaDraft = [];
  $("#postForm").reset();
  setEditorType("post");
  $("#editorTitle").textContent = "New post";
  clearDraftLocal();
}

function openNewPost() {
  resetEditor();
  restoreDraftLocal();
  showView("editor");
}

async function submitPost() {
  const account = $("#accountInput").value.trim();
  const caption = $("#captionInput").value.trim();
  const totalImages = Number($("#totalImagesInput").value || 0);
  const note = $("#noteInput").value.trim();

  if (!account || !caption) {
    showToast("Account and caption are required");
    return;
  }

  if (!state.mediaDraft.length) {
    showToast("Add at least one preview image");
    return;
  }

  const button = $("#sendForApprovalButton");
  const oldHtml = button.innerHTML;
  button.disabled = true;
  button.innerHTML = "<span>Saving…</span>";

  try {
    const post = {
      id: uid(),
      account,
      type: state.editorType,
      totalImages: state.editorType === "post"
        ? (totalImages || state.mediaDraft.length || 1)
        : 1,
      caption,
      note,
      comments: []
    };

    await persistPost(
      post,
      state.mediaDraft.map(m => m.dataUrl)
    );

    clearDraftLocal();
    resetEditor();
    showView("pending");
    showToast("Sent for approval");
  } catch (error) {
    console.error(error);
    showToast("Could not save post");
  } finally {
    button.disabled = false;
    button.innerHTML = oldHtml;
  }
}

function openApproval(postId) {
  const pending = state.posts
    .filter(p => p.status === "pending")
    .sort((a,b) => jsDate(a.createdAt) - jsDate(b.createdAt));

  state.approvalIds = pending.map(p => p.id);
  state.approvalIndex = Math.max(0, state.approvalIds.indexOf(postId));

  renderApproval();
  showView("approval");
}

function renderApproval() {
  const id = state.approvalIds[state.approvalIndex];
  const post = state.posts.find(p => p.id === id);

  if (!post || post.status !== "pending") {
    const pending = state.posts
      .filter(p => p.status === "pending")
      .sort((a,b) => jsDate(a.createdAt) - jsDate(b.createdAt));

    if (!pending.length) {
      showView("pending");
      return;
    }

    state.approvalIds = pending.map(p => p.id);
    state.approvalIndex = 0;
    return renderApproval();
  }

  state.activePostId = post.id;

  $("#approvalProgress").textContent =
    `PENDING ${state.approvalIndex + 1} / ${state.approvalIds.length}`;

  $("#approvalAccount").textContent = post.account;
  $("#approvalMeta").textContent = post.type === "reel"
    ? "Reel"
    : `Post · ${post.totalImages || 1} images`;

  $("#approvalCaption").textContent = post.caption;
  $("#approvalNote").textContent = post.note || "";
  $("#approvalNoteWrap").classList.toggle("hidden", !post.note);

  const urls = post.mediaDataUrls?.length
    ? post.mediaDataUrls
    : ["./Assets/media-placeholder.svg"];

  const shown = post.type === "reel" ? urls.slice(0,1) : urls.slice(0,3);

  $("#approvalMedia").className = `approval-media ${post.type}`;
  $("#approvalMedia").innerHTML = `
    ${shown.length > 1 ? `<span class="slide-counter">1/${shown.length}</span>` : ""}
    ${shown.map(src => `<img src="${src}" alt="" />`).join("")}
  `;

  const mediaBox = $("#approvalMedia");
  const counter = $(".slide-counter", mediaBox);

  if (counter) {
    mediaBox.addEventListener("scroll", () => {
      const index = Math.round(mediaBox.scrollLeft / mediaBox.clientWidth) + 1;
      counter.textContent = `${Math.min(index, shown.length)}/${shown.length}`;
    }, { passive:true });
  }

  $("#commentHistory").innerHTML = (post.comments || [])
    .map(c => `<div class="comment-item">${escapeHtml(c.text)}</div>`)
    .join("");
}

function openEditSheet() {
  const post = state.posts.find(p => p.id === state.activePostId);
  if (!post) return;

  $("#captionEditInput").value = post.caption;
  $("#sheetBackdrop").classList.remove("hidden");
  $("#editSheet").classList.remove("hidden");
}

function closeSheets() {
  $("#sheetBackdrop").classList.add("hidden");
  $("#editSheet").classList.add("hidden");
  $("#statusSheet").classList.add("hidden");
}

function openStatusSheet(postId) {
  state.activePostId = postId;
  $("#sheetBackdrop").classList.remove("hidden");
  $("#statusSheet").classList.remove("hidden");
}

function nextPendingAfterApproval() {
  const remaining = state.posts
    .filter(p => p.status === "pending" && p.id !== state.activePostId)
    .sort((a,b) => jsDate(a.createdAt) - jsDate(b.createdAt));

  if (!remaining.length) {
    showView("pending");
    return;
  }

  state.approvalIds = remaining.map(p => p.id);
  state.approvalIndex = Math.min(state.approvalIndex, remaining.length - 1);
  state.activePostId = state.approvalIds[state.approvalIndex];

  // Firestore snapshot will refresh state moments later.
  setTimeout(renderApproval, 150);
}


$("#newPostButton").addEventListener("click", openNewPost);

$("#pendingButton").addEventListener("click", () => {
  renderPending();
  showView("pending");
});

$("#approvedButton").addEventListener("click", () => {
  state.approvedTab = "ready";
  $$(".approved-tab").forEach(b =>
    b.classList.toggle("approved-tab-active", b.dataset.approvedTab === "ready")
  );
  renderApproved();
  showView("approved");
});

$$("[data-back]").forEach(btn => {
  btn.addEventListener("click", () => showView("home"));
});

$("#approvalView [data-back-approval]").addEventListener("click", () => {
  showView("pending");
});

$$(".segment").forEach(btn => {
  btn.addEventListener("click", () => setEditorType(btn.dataset.type));
});

$("#mediaInput").addEventListener("change", async e => {
  const files = [...e.target.files];
  const max = state.editorType === "reel" ? 1 : 3;
  const available = Math.max(0, max - state.mediaDraft.length);

  if (!available) {
    e.target.value = "";
    return;
  }

  showToast("Preparing preview…");

  try {
    for (const file of files.slice(0, available)) {
      const dataUrl = await compressImage(file, state.editorType);
      state.mediaDraft.push({
        name: file.name,
        dataUrl
      });
    }
    renderDraftMedia();
  } catch (error) {
    console.error(error);
    showToast("Could not process image");
  }

  e.target.value = "";
});

$("#postForm").addEventListener("submit", async e => {
  e.preventDefault();
  await submitPost();
});

$("#saveDraftButton").addEventListener("click", () => {
  saveDraftLocal();
  showToast("Draft saved");
});

["input","change"].forEach(evt => {
  $("#postForm").addEventListener(evt, saveDraftLocal);
});

$("#editCaptionButton").addEventListener("click", openEditSheet);

$("#saveCaptionEditButton").addEventListener("click", async () => {
  const text = $("#captionEditInput").value.trim();
  if (!text) return;

  await patchPost(state.activePostId, { caption: text });

  closeSheets();
  $("#approvalCaption").textContent = text;
  showToast("Caption updated");
});

$$(".sheet-cancel").forEach(btn => btn.addEventListener("click", closeSheets));
$("#sheetBackdrop").addEventListener("click", closeSheets);

$("#saveCommentButton").addEventListener("click", async () => {
  const input = $("#commentInput");
  const text = input.value.trim();
  if (!text) return;

  const post = state.posts.find(p => p.id === state.activePostId);
  if (!post) return;

  const comments = [
    ...(post.comments || []),
    {
      id: uid(),
      text,
      createdAt: nowISO(),
      by: state.user?.email || ""
    }
  ];

  await patchPost(post.id, { comments });

  input.value = "";
  showToast("Comment saved");
});

$("#requestEditButton").addEventListener("click", () => {
  $("#commentInput").focus();
  showToast("Add a short change request");
});

$("#approveButton").addEventListener("click", async () => {
  const id = state.activePostId;
  if (!id) return;

  const approveButton = $("#approveButton");
  approveButton.disabled = true;

  try {
    await patchPost(id, {
      status: "approved",
      approvedAt: serverTimestamp(),
      approvedBy: state.user?.uid || null,
      approvedByEmail: state.user?.email || null,
      postedLive: false
    });

    const brand = $("#brandButton");
    brand.classList.remove("brand-pulse");
    void brand.offsetWidth;
    brand.classList.add("brand-pulse");

    showToast("Approved");
    nextPendingAfterApproval();
  } finally {
    approveButton.disabled = false;
  }
});

$$(".approved-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    state.approvedTab = btn.dataset.approvedTab;

    $$(".approved-tab").forEach(b =>
      b.classList.toggle("approved-tab-active", b === btn)
    );

    renderApproved();
  });
});

$("#approvalMoreButton").addEventListener("click", () => {
  openStatusSheet(state.activePostId);
});

$("#convertToPendingButton").addEventListener("click", async () => {
  if (!state.activePostId) return;

  await patchPost(state.activePostId, {
    status: "pending",
    approvedAt: null,
    approvedBy: null,
    approvedByEmail: null,
    postedLive: false,
    postedAt: null
  });

  closeSheets();
  showView("pending");
  showToast("Moved to Pending");
});

$("#deletePostButton").addEventListener("click", async () => {
  if (!state.activePostId) return;

  const ok = confirm("Delete this post? This can’t be undone.");
  if (!ok) return;

  await removePost(state.activePostId);

  closeSheets();
  showView("pending");
  showToast("Deleted");
});

$("#brandButton").addEventListener("click", () => {
  const brand = $("#brandButton");
  brand.classList.remove("brand-pulse");
  void brand.offsetWidth;
  brand.classList.add("brand-pulse");
});

document.addEventListener("touchmove", e => {
  if (!e.target.closest(".scroll-zone, .approval-media")) {
    e.preventDefault();
  }
}, { passive:false });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(console.warn);
  });
}

onAuthStateChanged(auth, async user => {
  state.user = user;

  if (user) {
    subscribeToPosts();
    renderAll();
    showView("home");
    return;
  }

  if (state.unsubscribePosts) {
    state.unsubscribePosts();
    state.unsubscribePosts = null;
  }

  try {
    await signInAnonymously(auth);
  } catch (error) {
    console.error("Anonymous Firebase sign-in failed:", error);
    showView("home");
    showToast("Firebase access needs Anonymous enabled");
  }
});