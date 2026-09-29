import { firebaseConfig, firebaseConfigured } from "./firebase-config.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  posts: [],
  mediaDraft: [],
  editorType: "post",
  editingPostId: null,
  approvalIds: [],
  approvalIndex: 0,
  approvedTab: "ready",
  activePostId: null,
  firebase: null
};

const LOCAL_KEY = "wallee-approval-posts-v1";
const DRAFT_KEY = "wallee-approval-draft-v1";

const views = {
  home: $("#homeView"),
  editor: $("#editorView"),
  pending: $("#pendingView"),
  approval: $("#approvalView"),
  approved: $("#approvedView")
};

function uid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function escapeHtml(str = "") {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatApprovalDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d).replace(",", " ·");
}

function showView(name) {
  Object.values(views).forEach(v => v.classList.remove("view-active"));
  views[name].classList.add("view-active");
  history.replaceState({ view: name }, "", location.href);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 1800);
}

function saveLocal() {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(state.posts));
}

function loadLocal() {
  try {
    state.posts = JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]");
  } catch {
    state.posts = [];
  }
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

async function initFirebase() {
  if (!firebaseConfigured()) {
    console.info("Wallee: Firebase not configured. Using local-only mode.");
    return;
  }

  try {
    const [{ initializeApp }, firestore, storage] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js"),
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js")
    ]);

    const app = initializeApp(firebaseConfig);
    const db = firestore.getFirestore(app);
    const bucket = storage.getStorage(app);

    state.firebase = { firestore, storage, db, bucket };

    const q = firestore.query(
      firestore.collection(db, "approvalPosts"),
      firestore.orderBy("createdAt", "desc")
    );

    firestore.onSnapshot(q, snap => {
      state.posts = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      saveLocal();
      renderAll();
    });
  } catch (error) {
    console.error("Firebase init failed:", error);
    showToast("Firebase unavailable · local mode");
  }
}

async function persistPost(post, mediaFiles = []) {
  if (!state.firebase) {
    const existingIndex = state.posts.findIndex(p => p.id === post.id);
    if (existingIndex >= 0) state.posts[existingIndex] = post;
    else state.posts.unshift(post);
    saveLocal();
    renderAll();
    return;
  }

  const { firestore, storage, db, bucket } = state.firebase;
  let mediaUrls = post.mediaUrls || [];

  if (mediaFiles.length) {
    mediaUrls = [];
    for (const file of mediaFiles) {
      const path = `approval-posts/${post.id}/${uid()}-${file.name}`;
      const fileRef = storage.ref(bucket, path);
      await storage.uploadBytes(fileRef, file);
      mediaUrls.push(await storage.getDownloadURL(fileRef));
    }
  }

  const payload = { ...post, mediaUrls };
  delete payload.mediaPreviewUrls;
  await firestore.setDoc(firestore.doc(db, "approvalPosts", post.id), payload);
}

async function patchPost(id, patch) {
  const post = state.posts.find(p => p.id === id);
  if (!post) return;

  Object.assign(post, patch, { updatedAt: nowISO() });

  if (!state.firebase) {
    saveLocal();
    renderAll();
    return;
  }

  const { firestore, db } = state.firebase;
  await firestore.updateDoc(
    firestore.doc(db, "approvalPosts", id),
    { ...patch, updatedAt: nowISO() }
  );
}

async function removePost(id) {
  state.posts = state.posts.filter(p => p.id !== id);
  saveLocal();
  renderAll();

  if (state.firebase) {
    const { firestore, db } = state.firebase;
    await firestore.deleteDoc(firestore.doc(db, "approvalPosts", id));
  }
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
  return post.mediaUrls?.[0] || post.mediaPreviewUrls?.[0] || "./Assets/media-placeholder.svg";
}

function pendingCard(post) {
  const meta = post.type === "reel"
    ? "Reel"
    : `Post · ${post.totalImages || post.mediaUrls?.length || post.mediaPreviewUrls?.length || 1} images`;

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
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

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
    : `Post · ${post.totalImages || post.mediaUrls?.length || post.mediaPreviewUrls?.length || 1} images`;

  const statusLine = checked
    ? `Posted live ${formatApprovalDate(post.postedAt)}`
    : `Approved ${formatApprovalDate(post.approvedAt)}`;

  return `
    <div class="list-card approved-card" data-approved-row="${post.id}">
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
    .sort((a,b) => new Date(b.approvedAt || b.updatedAt) - new Date(a.approvedAt || a.updatedAt));

  posts = posts.filter(p => state.approvedTab === "posted" ? p.postedLive : !p.postedLive);

  $("#approvedList").innerHTML = posts.length
    ? posts.map(approvedCard).join("")
    : `<div class="empty-state">${state.approvedTab === "posted" ? "No posts marked live yet." : "No approved posts waiting to go live."}</div>`;

  $$("[data-toggle-posted]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const post = state.posts.find(p => p.id === btn.dataset.togglePosted);
      if (!post) return;
      const next = !post.postedLive;
      await patchPost(post.id, {
        postedLive: next,
        postedAt: next ? nowISO() : null
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
  renderDraftMedia();
}

function renderDraftMedia() {
  const isReel = state.editorType === "reel";
  const items = isReel ? state.mediaDraft.slice(0,1) : state.mediaDraft.slice(0,3);

  $("#mediaGrid").innerHTML = items.map((item,index) => `
    <div class="media-thumb ${isReel ? "reel" : ""}">
      <img src="${item.preview}" alt="Preview ${index + 1}" />
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
  state.editingPostId = null;
  state.mediaDraft.forEach(m => URL.revokeObjectURL(m.preview));
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

  if (!state.mediaDraft.length && !state.editingPostId) {
    showToast("Add at least one preview image");
    return;
  }

  const post = {
    id: state.editingPostId || uid(),
    account,
    type: state.editorType,
    totalImages: state.editorType === "post" ? (totalImages || state.mediaDraft.length || 1) : 1,
    caption,
    note,
    status: "pending",
    comments: [],
    postedLive: false,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    approvedAt: null,
    postedAt: null
  };

  const mediaFiles = state.mediaDraft.map(m => m.file).filter(Boolean);

  if (!state.firebase) {
    post.mediaPreviewUrls = state.mediaDraft.map(m => m.preview);
  }

  await persistPost(post, mediaFiles);
  clearDraftLocal();
  resetEditor();
  showView("pending");
  showToast("Sent for approval");
}

function openApproval(postId) {
  const pending = state.posts
    .filter(p => p.status === "pending")
    .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));

  state.approvalIds = pending.map(p => p.id);
  state.approvalIndex = Math.max(0, state.approvalIds.indexOf(postId));
  renderApproval();
  showView("approval");
}

function renderApproval() {
  const id = state.approvalIds[state.approvalIndex];
  const post = state.posts.find(p => p.id === id);
  if (!post) {
    showView("pending");
    return;
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

  const urls = post.mediaUrls?.length
    ? post.mediaUrls
    : post.mediaPreviewUrls?.length
      ? post.mediaPreviewUrls
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
    .filter(p => p.status === "pending")
    .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (!remaining.length) {
    showView("pending");
    return;
  }

  state.approvalIds = remaining.map(p => p.id);
  state.approvalIndex = Math.min(state.approvalIndex, remaining.length - 1);
  renderApproval();
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

$$("[data-back]").forEach(btn => btn.addEventListener("click", () => showView("home")));

$$(".segment").forEach(btn => btn.addEventListener("click", () => setEditorType(btn.dataset.type)));

$("#mediaInput").addEventListener("change", e => {
  const files = [...e.target.files];
  const max = state.editorType === "reel" ? 1 : 3;
  const available = Math.max(0, max - state.mediaDraft.length);

  files.slice(0, available).forEach(file => {
    state.mediaDraft.push({
      file,
      preview: URL.createObjectURL(file)
    });
  });

  e.target.value = "";
  renderDraftMedia();
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
  renderApproval();
  showToast("Caption updated");
});

$$(".sheet-cancel").forEach(btn => btn.addEventListener("click", closeSheets));
$("#sheetBackdrop").addEventListener("click", closeSheets);

$("#saveCommentButton").addEventListener("click", async () => {
  const input = $("#commentInput");
  const text = input.value.trim();
  if (!text) return;

  const post = state.posts.find(p => p.id === state.activePostId);
  const comments = [...(post.comments || []), { id:uid(), text, createdAt:nowISO() }];

  await patchPost(post.id, { comments });
  input.value = "";
  renderApproval();
  showToast("Comment saved");
});

$("#requestEditButton").addEventListener("click", () => {
  $("#commentInput").focus();
  showToast("Add a short change request");
});

$("#approveButton").addEventListener("click", async () => {
  const id = state.activePostId;
  await patchPost(id, {
    status: "approved",
    approvedAt: nowISO(),
    postedLive: false
  });

  const brand = $("#brandButton");
  brand.classList.remove("brand-pulse");
  void brand.offsetWidth;
  brand.classList.add("brand-pulse");

  showToast("Approved");
  nextPendingAfterApproval();
});

$$(".approved-tab").forEach(btn => btn.addEventListener("click", () => {
  state.approvedTab = btn.dataset.approvedTab;
  $$(".approved-tab").forEach(b =>
    b.classList.toggle("approved-tab-active", b === btn)
  );
  renderApproved();
}));

$("#approvalMoreButton").addEventListener("click", () => openStatusSheet(state.activePostId));

$("#convertToPendingButton").addEventListener("click", async () => {
  if (!state.activePostId) return;
  await patchPost(state.activePostId, {
    status: "pending",
    approvedAt: null,
    postedLive: false,
    postedAt: null
  });
  closeSheets();
  showView("pending");
  showToast("Moved to Pending");
});

$("#deletePostButton").addEventListener("click", async () => {
  if (!state.activePostId) return;
  const ok = confirm("Delete this post?");
  if (!ok) return;
  await removePost(state.activePostId);
  closeSheets();
  showView("home");
  showToast("Deleted");
});

$("#brandButton").addEventListener("click", () => {
  $("#brandButton").classList.remove("brand-pulse");
  void $("#brandButton").offsetWidth;
  $("#brandButton").classList.add("brand-pulse");
});

window.addEventListener("resize", () => {
  document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
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

loadLocal();
renderAll();
initFirebase();
