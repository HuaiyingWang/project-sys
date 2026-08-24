"use strict";

/* ═══════════ 常數 ═══════════ */
const STATUSES = [
  { key:"doing", label:"進行中", cls:"badge--doing" },
  { key:"live",  label:"已上線", cls:"badge--live"  },
  { key:"maint", label:"維護中", cls:"badge--maint" },
  { key:"off",   label:"已停用", cls:"badge--off"   },
];
/* 舊版的固定來源，僅用於顯示既有紀錄 */
const LEGACY_SOURCES = [
  { key:"boss",   label:"老闆", cls:"tag--boss"   },
  { key:"client", label:"業務", cls:"tag--client" },
  { key:"self",   label:"我自己", cls:"tag--self" },
];
const SOON_DAYS = 30;

/* ═══════════ Firebase（雲端同步資料庫） ═══════════ */
/* 建立 Firebase 專案後，把 Console 給的設定值整包貼進來，設定步驟見 README。 */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD97LLKIE4yoZPpTcu7tM6TEQcV3TcGfhc",
  authDomain: "tool-project-f3bb0.firebaseapp.com",
  projectId: "tool-project-f3bb0",
};
const FIREBASE_READY = !FIREBASE_CONFIG.apiKey.includes("YOUR-API-KEY");
if(FIREBASE_READY) firebase.initializeApp(FIREBASE_CONFIG);
const fdb = FIREBASE_READY ? firebase.firestore() : null;

/* 圖片／檔案不用額外的雲端儲存空間（避免要求信用卡），直接把內容轉成 base64 存進 Firestore 文件。
   Firestore 單一文件上限 1MB，base64 會把體積脹大約 1/3，所以原始檔案大小上限抓 700KB（見 MAX_ATTACHMENT_BYTES）。 */
async function dbAllBlobMeta(name){
  const snap = await fdb.collection(name).get();
  return snap.docs.map(d => ({ id: d.id, name: d.data().name, type: d.data().type }));
}
async function dbGetBlob(name, id){
  const doc = await fdb.collection(name).doc(id).get();
  if(!doc.exists) return undefined;
  const meta = doc.data();
  const blob = await dataUrlToBlob(meta.data);
  return { id, name: meta.name, type: meta.type, blob };
}
async function dbPutBlob(name, val){
  const type = val.type || (val.blob && val.blob.type) || "application/octet-stream";
  const dataUrl = await blobToDataUrl(val.blob);
  await fdb.collection(name).doc(val.id).set({ name: val.name, type, data: dataUrl });
  return val;
}
async function dbDelBlob(name, id){
  await fdb.collection(name).doc(id).delete();
}

async function dbAll(name){
  if(name === "images" || name === "files") return dbAllBlobMeta(name);
  const snap = await fdb.collection(name).get();
  return snap.docs.map(d => d.data());
}
async function dbGet(name, id){
  if(name === "images" || name === "files") return dbGetBlob(name, id);
  const doc = await fdb.collection(name).doc(id).get();
  return doc.exists ? doc.data() : undefined;
}
async function dbPut(name, val){
  if(name === "images" || name === "files") return dbPutBlob(name, val);
  await fdb.collection(name).doc(val.id).set(val);
  return val;
}
async function dbDel(name, id){
  if(name === "images" || name === "files") return dbDelBlob(name, id);
  await fdb.collection(name).doc(id).delete();
}
async function dbClear(name){
  const snap = await fdb.collection(name).get();
  const batch = fdb.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}
async function dbByIndex(name, idx, val){
  const all = await dbAll(name);
  return all.filter(r => r[idx] === val);
}

/* 其他分頁／裝置改了資料時，重新載入並刷新畫面，但避開正在編輯中的表單 */
function subscribeRealtime(){
  let t = null;
  const trigger = () => { clearTimeout(t); t = setTimeout(syncRefresh, 500); };
  ["projects", "reqs", "contacts"].forEach(col => fdb.collection(col).onSnapshot(trigger));
}
async function syncRefresh(){
  if($$("dialog").some(d => d.open)) return;
  await loadAll();
  if(state.currentId){
    const composing = ($("#r-content") && $("#r-content").value.trim()) || state.draftImages.length || state.draftFiles.length;
    if(!composing) openDetail(state.currentId);
    else await renderTimeline(state.currentId);
  } else {
    renderList();
  }
}

/* ═══════════ 狀態 ═══════════ */
const state = {
  projects: [], reqs: [], contacts: [],
  filter: { q:"", status:"all" },
  sort: "updated",
  currentId: null,
  tab: "basic",
  draftImages: [],
  draftFiles: [],
  editingReqId: null,
  reqOnlyOpen: false,
};
const urlCache = new Map();

/* ═══════════ 小工具 ═══════════ */
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,9);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

function statusOf(key){ return STATUSES.find(s => s.key === key) || STATUSES[0]; }
/* 需求來源：優先讀聯絡窗口，讀不到才退回舊版固定值 */
function reqSource(r){
  if(r.sourceContactId){
    const c = state.contacts.find(x => x.id === r.sourceContactId);
    if(c) return { label: c.name, cls: "tag--contact" };
    return { label: (r.sourceName ? r.sourceName + "（已移除）" : "已移除的窗口"), cls: "tag--self" };
  }
  const s = LEGACY_SOURCES.find(x => x.key === r.source);
  return s || { label: "我自己", cls: "tag--self" };
}

function fmtDay(ms){
  if(!ms) return "—";
  const d = new Date(ms);
  if(isNaN(d)) return "—";
  const p2 = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function daysUntil(dateStr){
  if(!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if(isNaN(d)) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((d - today) / 86400000);
}
function expiryLevel(dateStr, status){
  if(status === "off") return "";
  const d = daysUntil(dateStr);
  if(d === null) return "";
  if(d < 0) return "over";
  if(d <= SOON_DAYS) return "soon";
  return "";
}
function normUrl(v){
  if(!v) return "";
  return /^https?:\/\//i.test(v) ? v : "https://" + v;
}
function toast(msg){
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("toast--on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("toast--on"), 2600);
}
function objectUrl(id, blob){
  if(!urlCache.has(id)) urlCache.set(id, URL.createObjectURL(blob));
  return urlCache.get(id);
}

function openImagePreview(rec){
  $("#dlg-image-img").src = objectUrl(rec.id, rec.blob);
  $("#dlg-image-img").alt = rec.name || "圖片";
  $("#dlg-image-title").textContent = rec.name || "圖片";
  $("#dlg-image").showModal();
}

const TEXT_PREVIEW_EXT = ["txt","md","markdown","json","csv","log","yml","yaml","xml"];
function fileKind(name, type){
  const ext = String(name || "").split(".").pop().toLowerCase();
  if((type && type.startsWith("image/"))) return "image";
  if(type === "application/pdf" || ext === "pdf") return "pdf";
  if((type && type.startsWith("text/")) || TEXT_PREVIEW_EXT.includes(ext)) return "text";
  return "other";
}
async function openFilePreview(rec){
  const kind = fileKind(rec.name, rec.blob.type);
  const url = objectUrl(rec.id, rec.blob);
  $("#dlg-file-title").textContent = rec.name || "檔案";
  const dl = $("#dlg-file-dl");
  dl.href = url;
  dl.setAttribute("download", rec.name || "檔案");
  const body = $("#dlg-file-body");
  if(kind === "image"){
    body.innerHTML = `<img src="${url}" alt="${esc(rec.name)}" style="display:block;max-width:100%;max-height:82vh;margin:0 auto">`;
  } else if(kind === "pdf"){
    body.innerHTML = `<iframe class="filepreview-frame" src="${url}" title="${esc(rec.name)}"></iframe>`;
  } else if(kind === "text"){
    body.innerHTML = `<pre class="filepreview-text"></pre>`;
    try { body.querySelector("pre").textContent = await rec.blob.text(); }
    catch { body.innerHTML = `<p class="filepreview-empty">無法讀取檔案內容。</p>`; }
  } else {
    body.innerHTML = `<p class="filepreview-empty">這個檔案類型無法在瀏覽器內預覽，請按右上角「下載」開啟。</p>`;
  }
  $("#dlg-file").showModal();
}
function openConfirm(message, onYes){
  const dlg = $("#dlg-confirm");
  $("#dlg-confirm-body").textContent = message;
  const yes = $("#confirm-yes");
  const fresh = yes.cloneNode(true);
  yes.replaceWith(fresh);
  fresh.addEventListener("click", () => { dlg.close(); onYes(); });
  dlg.showModal();
  fresh.focus();
}
$("#confirm-no").addEventListener("click", () => $("#dlg-confirm").close());
$$("[data-close]").forEach(b => b.addEventListener("click", e => e.target.closest("dialog").close()));

/* ═══════════ 讀取資料 ═══════════ */
async function loadAll(){
  state.projects = await dbAll("projects");
  state.reqs     = await dbAll("reqs");
  state.contacts = (await dbAll("contacts")).sort((a,b) => a.name.localeCompare(b.name, "zh-Hant"));
}
/* 解析專案的聯絡窗口。舊資料曾把姓名電話直接存在專案上，這裡一併相容。 */
function contactOf(p){
  if(p.contactId){
    const c = state.contacts.find(x => x.id === p.contactId);
    if(c) return c;
  }
  if(p.contact || p.phone || p.email)
    return { id:null, name:p.contact || "", org:"", title:"", phone:p.phone || "", email:p.email || "", legacy:true };
  return null;
}
function contactLabel(c){
  if(!c) return "";
  return c.org ? `${c.name}（${c.org}）` : c.name;
}
function contactUseCount(id){
  return state.projects.filter(p => p.contactId === id).length;
}
function sourceOptions(selectedId){
  return `<option value="">我自己</option>` + state.contacts.map(c =>
    `<option value="${c.id}"${c.id === selectedId ? " selected" : ""}>${esc(contactLabel(c))}</option>`).join("");
}
function defaultSourceId(){
  const p = state.projects.find(x => x.id === state.currentId);
  return p && p.contactId && state.contacts.some(c => c.id === p.contactId) ? p.contactId : "";
}
function openReqCount(projectId){
  return state.reqs.filter(r => r.projectId === projectId && !r.done).length;
}

/* ═══════════ 列表頁 ═══════════ */
function visibleProjects(){
  const q = state.filter.q.trim().toLowerCase();
  let list = state.projects.filter(p => {
    if(state.filter.status !== "all" && p.status !== state.filter.status) return false;
    if(!q) return true;
    const c = contactOf(p);
    return [p.name, p.client, p.domain, p.testUrl, p.host, p.note, (p.tags||[]).join(" "), c && c.name, c && c.org]
      .some(v => String(v||"").toLowerCase().includes(q));
  });
  const cmp = {
    updated: (a,b) => (b.updatedAt||0) - (a.updatedAt||0),
    created: (a,b) => (b.createdAt||0) - (a.createdAt||0),
    name:    (a,b) => a.name.localeCompare(b.name, "zh-Hant"),
    client:  (a,b) => String(a.client||"").localeCompare(String(b.client||""), "zh-Hant"),
    reqs:    (a,b) => openReqCount(b.id) - openReqCount(a.id),
    expiry:  (a,b) => {
      const da = a.expiryDate ? new Date(a.expiryDate) : Infinity;
      const dbb = b.expiryDate ? new Date(b.expiryDate) : Infinity;
      return da - dbb;
    },
  }[state.sort];
  return list.sort(cmp);
}

function renderChips(){
  const counts = { all: state.projects.length };
  STATUSES.forEach(s => counts[s.key] = state.projects.filter(p => p.status === s.key).length);
  const items = [{ key:"all", label:"全部" }, ...STATUSES];
  $("#chips").innerHTML = items.map(s => `
    <button class="chip" type="button" data-status="${s.key}" aria-pressed="${state.filter.status === s.key}">
      ${esc(s.label)}<span class="chip__count">${counts[s.key]}</span>
    </button>`).join("");
}

function renderList(){
  renderChips();
  const rows = visibleProjects();
  $("#resultbar").textContent = state.projects.length
    ? `顯示 ${rows.length} / ${state.projects.length} 個專案`
    : "";

  if(!state.projects.length){
    $("#list-sheet").innerHTML = `
      <div class="sheet empty">
        <p class="empty__title">建立你的第一個專案</p>
        <p class="empty__body">把手上的案子放進來，之後就能追蹤狀態、到期日和客戶的需求。</p>
        <button class="btn btn--primary" type="button" onclick="document.getElementById('btn-new').click()">新增專案</button>
      </div>`;
    return;
  }
  if(!rows.length){
    $("#list-sheet").innerHTML = `
      <div class="sheet empty">
        <p class="empty__title">沒有符合的專案</p>
        <p class="empty__body">換個關鍵字，或把狀態篩選切回「全部」。</p>
      </div>`;
    return;
  }

  $("#list-sheet").innerHTML = `
    <div class="cards" role="list" aria-label="專案列表，共 ${rows.length} 筆">
      ${rows.map(cardHTML).join("")}
    </div>`;

  $$("#list-sheet .card").forEach(card => {
    card.addEventListener("click", e => {
      if(e.target.closest("a, select")) return;
      openDetail(card.dataset.id);
    });
  });
  $$("#list-sheet .status-select").forEach(sel => {
    sel.addEventListener("change", e => {
      e.stopPropagation();
      quickSetStatus(sel.dataset.id, sel.value);
    });
  });
}

async function quickSetStatus(id, status){
  const p = state.projects.find(x => x.id === id);
  if(!p || p.status === status) return;
  await dbPut("projects", { ...p, status, updatedAt: Date.now() });
  await loadAll();
  renderList();
  toast("狀態已更新");
}

function cardHTML(p){
  const st = statusOf(p.status);
  const lv = expiryLevel(p.expiryDate, p.status);
  const n  = openReqCount(p.id);
  const d  = daysUntil(p.expiryDate);
  let dateText = "未設定到期日";
  if(p.expiryDate){
    dateText = "到期 " + p.expiryDate;
    if(lv === "over") dateText += `（逾期 ${Math.abs(d)} 天）`;
    else if(lv === "soon") dateText += `（剩 ${d} 天）`;
  }
  const link = p.domain
    ? `<a class="card__link" href="${esc(normUrl(p.domain))}" target="_blank" rel="noopener">${esc(p.domain)} ↗</a>`
    : "";
  const ct = contactOf(p);
  return `
    <article class="card ${lv ? "card--" + lv : ""}" data-id="${p.id}" role="listitem">
      <div class="card__top">
        <div>
          <button class="card__name" type="button">${esc(p.name)}</button>
          ${link}
        </div>
        <span class="card__created">${fmtDay(p.createdAt)}</span>
      </div>
      <div class="card__sub-row">
        <span class="card__sub">${esc(p.client) || "—"}</span>
        ${ct && ct.name ? `<span class="card__contact">窗口 ${esc(ct.name)}</span>` : ""}
      </div>
      <div class="card__foot">
        <label>
          <span class="sr-only">狀態</span>
          <select class="status-select ${st.cls}" data-id="${p.id}">
            ${STATUSES.map(s => `<option value="${s.key}" ${s.key === p.status ? "selected" : ""}>${esc(s.label)}</option>`).join("")}
          </select>
        </label>
        <span class="card__expiry ${lv ? "card__expiry--" + lv : ""}">${esc(dateText)}</span>
        <span class="card__reqs"><span class="pill-count ${n ? "pill-count--some" : "pill-count--zero"}">${n}</span>待辦需求</span>
      </div>
    </article>`;
}

$("#q").addEventListener("input", e => { state.filter.q = e.target.value; renderList(); });
$("#sort").addEventListener("change", e => { state.sort = e.target.value; renderList(); });
$("#chips").addEventListener("click", e => {
  const b = e.target.closest("[data-status]");
  if(!b) return;
  state.filter.status = b.dataset.status;
  renderList();
});

/* ═══════════ 專案表單 ═══════════ */
$("#f-status").innerHTML = STATUSES.map(s => `<option value="${s.key}">${s.label}</option>`).join("");

let editingId = null;

function fillContactSelect(selectedId){
  const sel = $("#f-contact");
  sel.innerHTML = `<option value="">— 未指定 —</option>` +
    state.contacts.map(c => `<option value="${c.id}">${esc(contactLabel(c))}</option>`).join("");
  sel.value = selectedId && state.contacts.some(c => c.id === selectedId) ? selectedId : "";
  updateContactPreview();
}
function updateContactPreview(){
  const c = state.contacts.find(x => x.id === $("#f-contact").value);
  const el = $("#contact-preview");
  if(!c){ el.textContent = "電話與信箱跟著窗口資料走，改一次全部專案都會更新。"; return; }
  const bits = [c.title, c.phone, c.email].filter(Boolean);
  el.textContent = bits.length ? bits.join("　·　") : "這位窗口還沒填電話或信箱。";
}
$("#f-contact").addEventListener("change", updateContactPreview);

function openProjectForm(id){
  editingId = id || null;
  const p = id ? state.projects.find(x => x.id === id) : null;
  const f = $("#form-project");
  $("#dlg-project-title").textContent = p ? "編輯專案" : "新增專案";
  f.reset();
  fillContactSelect(p ? p.contactId : "");
  if(p){
    f.elements.name.value = p.name || "";
    f.elements.status.value = p.status || "doing";
    f.elements.client.value = p.client || "";
    f.elements.domain.value = p.domain || "";
    f.elements.testUrl.value = p.testUrl || "";
    f.elements.adminUrl.value = p.adminUrl || "";
    f.elements.host.value = p.host || "";
    f.elements.ftpHost.value = p.ftpHost || "";
    f.elements.ftpUser.value = p.ftpUser || "";
    f.elements.ftpNote.value = p.ftpNote || "";
    f.elements.launchDate.value = p.launchDate || "";
    f.elements.expiryDate.value = p.expiryDate || "";
    f.elements.tags.value = (p.tags || []).join(", ");
    f.elements.note.value = p.note || "";
  }
  $("#dlg-project").showModal();
  setTimeout(() => f.elements.name.focus(), 40);
}

$("#form-project").addEventListener("submit", async e => {
  const f = e.target;
  if(!f.elements.name.value.trim()){ e.preventDefault(); return; }
  const now = Date.now();
  const base = editingId ? state.projects.find(p => p.id === editingId) : { id: uid(), createdAt: now };
  const rec = {
    ...base,
    name: f.elements.name.value.trim(),
    status: f.elements.status.value,
    client: f.elements.client.value.trim(),
    contactId: f.elements.contactId.value || "",
    domain: f.elements.domain.value.trim(),
    testUrl: f.elements.testUrl.value.trim(),
    adminUrl: f.elements.adminUrl.value.trim(),
    host: f.elements.host.value.trim(),
    ftpHost: f.elements.ftpHost.value.trim(),
    ftpUser: f.elements.ftpUser.value.trim(),
    ftpNote: f.elements.ftpNote.value.trim(),
    launchDate: f.elements.launchDate.value,
    expiryDate: f.elements.expiryDate.value,
    tags: f.elements.tags.value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    note: f.elements.note.value.trim(),
    updatedAt: now,
  };
  if(rec.contactId){ delete rec.contact; delete rec.phone; delete rec.email; }
  const wasNew = !editingId;
  await dbPut("projects", rec);
  await loadAll();
  toast(editingId ? "專案已更新" : "專案已建立");
  if(wasNew) openDetail(rec.id);
  else if(state.currentId) openDetail(state.currentId);
  else renderList();
});

$("#btn-new").addEventListener("click", () => openProjectForm(null));

/* ═══════════ 詳細頁 ═══════════ */
async function openDetail(id){
  state.currentId = id;
  const p = state.projects.find(x => x.id === id);
  if(!p) return backToList();
  $("#view-list").hidden = true;
  const view = $("#view-detail");
  view.hidden = false;
  view.innerHTML = detailHTML(p);
  bindDetail(p);
  await renderTimeline(p.id);
  view.querySelector("#btn-back").focus();
  window.scrollTo({ top:0, behavior:"instant" });
}

function backToList(){
  state.currentId = null;
  state.draftImages = [];
  $("#view-detail").hidden = true;
  $("#view-list").hidden = false;
  renderList();
  $("#q").focus();
}

function fieldHTML(label, value, opts = {}){
  let inner;
  if(!value) inner = `<div class="field__value field__value--empty">—</div>`;
  else if(opts.link) inner = `<div class="field__value field__value--mono"><a href="${esc(normUrl(value))}" target="_blank" rel="noopener">${esc(value)} ↗</a></div>`;
  else if(opts.mail) inner = `<div class="field__value field__value--mono"><a href="mailto:${esc(value)}">${esc(value)}</a></div>`;
  else if(opts.tel)  inner = `<div class="field__value field__value--mono"><a href="tel:${esc(value.replace(/\s/g,""))}">${esc(value)}</a></div>`;
  else inner = `<div class="field__value ${opts.mono ? "field__value--mono" : ""}">${esc(value)}</div>`;
  return `<div class="field"><div class="field__label">${esc(label)}</div>${inner}</div>`;
}

function detailHTML(p){
  const st = statusOf(p.status);
  const ct = contactOf(p);
  const lv = expiryLevel(p.expiryDate, p.status);
  const d  = daysUntil(p.expiryDate);
  const warn = lv === "over"
    ? `<p class="warnbar warnbar--over">維護已於 ${p.expiryDate} 到期，逾期 ${Math.abs(d)} 天。</p>`
    : lv === "soon"
    ? `<p class="warnbar warnbar--soon">維護將於 ${p.expiryDate} 到期，剩 ${d} 天。</p>`
    : "";
  const tags = (p.tags || []).length
    ? `<span>${p.tags.map(t => `<span class="tag tag--self" style="margin-right:5px">${esc(t)}</span>`).join("")}</span>`
    : "";

  return `
  <h2 class="sr-only" id="detail-title">${esc(p.name)} 專案詳細資料</h2>
  <div class="detail__top">
    <button class="btn btn--ghost btn--sm" id="btn-back" type="button">
      <svg class="btn__ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
      回列表
    </button>
    <div class="detail__actions">
      <button class="btn btn--sm" id="btn-edit" type="button">編輯資料</button>
      <button class="btn btn--sm" id="btn-dup" type="button">複製此專案</button>
      <button class="btn btn--sm btn--danger" id="btn-del" type="button">刪除專案</button>
    </div>
  </div>

  <h3 class="detail__title">${esc(p.name)}</h3>
  <div class="detail__meta">
    <span class="badge ${st.cls}">${st.label}</span>
    ${p.client ? `<span>${esc(p.client)}</span>` : ""}
    ${tags}
  </div>
  ${warn}

  <div class="tabs" role="tablist" aria-label="專案分頁">
    <button class="tab" role="tab" id="tab-basic" aria-controls="panel-basic" aria-selected="${state.tab==="basic"}" type="button" data-tab="basic">基本資料</button>
    <button class="tab" role="tab" id="tab-tech"  aria-controls="panel-tech"  aria-selected="${state.tab==="tech"}"  type="button" data-tab="tech">技術資訊</button>
    <button class="tab" role="tab" id="tab-reqs"  aria-controls="panel-reqs"  aria-selected="${state.tab==="reqs"}"  type="button" data-tab="reqs">需求紀錄</button>
  </div>

  <div class="panel" id="panel-basic" role="tabpanel" aria-labelledby="tab-basic" tabindex="0" ${state.tab==="basic"?"":"hidden"}>
    <div class="field-grid">
      ${fieldHTML("業務", p.client)}
      ${ct ? `
        ${fieldHTML("聯絡窗口", ct.title ? `${ct.name}　${ct.title}` : ct.name)}
        ${fieldHTML("所屬單位", ct.org)}
        ${fieldHTML("聯絡電話", ct.phone, {tel:true})}
        ${fieldHTML("聯絡信箱", ct.email, {mail:true})}` : `
        <div class="field field--cta" style="grid-column:1/-1">
          <div>
            <div class="field__label">聯絡窗口</div>
            <div class="field__value field__value--empty">尚未指定</div>
          </div>
          <button class="btn btn--sm" type="button" id="btn-assign-contact">指定窗口</button>
        </div>`}
      ${fieldHTML("上線日期", p.launchDate, {mono:true})}
      ${fieldHTML("維護到期日", p.expiryDate, {mono:true})}
    </div>
    ${p.note ? `<div class="note-block">${esc(p.note)}</div>` : ""}
  </div>

  <div class="panel" id="panel-tech" role="tabpanel" aria-labelledby="tab-tech" tabindex="0" ${state.tab==="tech"?"":"hidden"}>
    <div class="field-grid">
      ${fieldHTML("正式網域", p.domain, {link:true})}
      ${fieldHTML("測試站網址", p.testUrl, {link:true})}
      ${fieldHTML("後台網址", p.adminUrl, {link:true})}
      ${fieldHTML("主機商 / 主機", p.host, {mono:true})}
      ${fieldHTML("FTP 位址", p.ftpHost, {mono:true})}
      ${fieldHTML("FTP 帳號", p.ftpUser, {mono:true})}
      ${fieldHTML("密碼存放位置", p.ftpNote)}
    </div>
  </div>

  <div class="panel" id="panel-reqs" role="tabpanel" aria-labelledby="tab-reqs" tabindex="0" ${state.tab==="reqs"?"":"hidden"}>
    <form class="reqform" id="form-req">
      <div class="reqform__row">
        <div style="flex:0 0 auto">
          <label class="lbl" for="r-date">日期</label>
          <input class="inp" id="r-date" type="date" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div style="flex:1 1 230px;min-width:190px">
          <label class="lbl" for="r-source">來源</label>
          <div class="picker">
            <select class="inp" id="r-source">${sourceOptions(p.contactId)}</select>
            <button class="btn" type="button" id="r-add-contact" title="新增聯絡窗口">＋</button>
          </div>
        </div>
      </div>
      <label class="lbl" for="r-content">需求內容</label>
      <textarea class="ta" id="r-content" placeholder="老闆說首頁 banner 要換成新版⋯（可直接 Ctrl+V 貼上截圖，或把圖片拖進來）"></textarea>
      <div class="thumbs" id="r-thumbs"></div>
      <div class="filelist" id="r-filelist"></div>
      <p class="reqform__hint">支援貼上、拖放，或
        <button class="btn btn--sm btn--ghost" type="button" id="r-pick">選擇圖片</button>
        <button class="btn btn--sm btn--ghost" type="button" id="r-pick-file">選擇檔案</button>
        （單一檔案上限 700KB）
      </p>
      <input type="file" id="r-file" accept="image/*" multiple class="sr-only" tabindex="-1">
      <input type="file" id="r-filedoc" multiple class="sr-only" tabindex="-1">
      <div class="dlg__foot" style="padding:12px 0 0;border:0">
        <button class="btn" type="button" id="req-cancel" hidden>取消編輯</button>
        <button class="btn btn--primary" type="submit" id="req-submit">新增需求</button>
      </div>
    </form>
    <div class="tl-bar">
      <label><input type="checkbox" id="req-only-open"> 只看未完成</label>
      <span class="tl-summary" id="req-summary"></span>
    </div>
    <div id="timeline"></div>
  </div>`;
}

function bindDetail(p){
  $("#btn-back").addEventListener("click", backToList);
  $("#btn-edit").addEventListener("click", () => openProjectForm(p.id));
  const assign = $("#btn-assign-contact");
  if(assign) assign.addEventListener("click", () => openProjectForm(p.id));
  $("#btn-dup").addEventListener("click", () => duplicateProject(p));
  $("#btn-del").addEventListener("click", () =>
    openConfirm(`確定要刪除「${p.name}」嗎？這個專案底下的所有需求紀錄、圖片和檔案也會一併移除，且無法復原。`,
      () => deleteProject(p.id)));

  $$(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  $(".tabs").addEventListener("keydown", e => {
    const tabs = $$(".tab");
    const i = tabs.indexOf(document.activeElement);
    if(i < 0) return;
    let n = null;
    if(e.key === "ArrowRight") n = (i + 1) % tabs.length;
    if(e.key === "ArrowLeft")  n = (i - 1 + tabs.length) % tabs.length;
    if(n === null) return;
    e.preventDefault();
    tabs[n].focus(); switchTab(tabs[n].dataset.tab);
  });

  state.draftImages = [];
  state.draftFiles = [];
  state.editingReqId = null;
  renderDraftThumbs();
  renderDraftFiles();
  const ta = $("#r-content");
  ta.addEventListener("paste", e => {
    const files = [...(e.clipboardData?.items || [])]
      .filter(i => i.kind === "file" && i.type.startsWith("image/"))
      .map(i => i.getAsFile());
    if(files.length){ e.preventDefault(); addDraftImages(files); }
  });
  ["dragover","dragenter"].forEach(ev => ta.addEventListener(ev, e => { e.preventDefault(); ta.classList.add("dropzone"); }));
  ["dragleave","drop"].forEach(ev => ta.addEventListener(ev, () => ta.classList.remove("dropzone")));
  ta.addEventListener("drop", e => {
    e.preventDefault();
    const all = [...e.dataTransfer.files];
    const imgs = all.filter(f => f.type.startsWith("image/"));
    const docs = all.filter(f => !f.type.startsWith("image/"));
    if(imgs.length) addDraftImages(imgs);
    if(docs.length) addDraftFiles(docs);
  });
  $("#r-pick").addEventListener("click", () => $("#r-file").click());
  $("#r-file").addEventListener("change", e => { addDraftImages([...e.target.files]); e.target.value = ""; });
  $("#r-pick-file").addEventListener("click", () => $("#r-filedoc").click());
  $("#r-filedoc").addEventListener("change", e => { addDraftFiles([...e.target.files]); e.target.value = ""; });
  $("#form-req").addEventListener("submit", e => { e.preventDefault(); saveRequirement(p.id); });
  $("#r-add-contact").addEventListener("click", () => openContactForm(null, "req"));
  $("#req-cancel").addEventListener("click", () => resetReqForm());
  $("#req-only-open").checked = state.reqOnlyOpen;
  $("#req-only-open").addEventListener("change", e => {
    state.reqOnlyOpen = e.target.checked;
    renderTimeline(p.id);
  });
}

function switchTab(key){
  state.tab = key;
  $$(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.tab === key)));
  ["basic","tech","reqs"].forEach(k => { $("#panel-" + k).hidden = (k !== key); });
}

/* ═══════════ 複製 / 刪除專案 ═══════════ */
async function duplicateProject(p){
  const now = Date.now();
  const copy = { ...p, id: uid(), name: p.name + "（複本）", createdAt: now, updatedAt: now };
  await dbPut("projects", copy);
  await loadAll();
  toast("已複製專案，需求紀錄未一併複製");
  openDetail(copy.id);
}

async function deleteProject(id){
  const reqs = await dbByIndex("reqs", "projectId", id);
  for(const r of reqs){
    for(const imgId of (r.images || [])) await dbDel("images", imgId);
    for(const fileId of (r.files || [])) await dbDel("files", fileId);
    await dbDel("reqs", r.id);
  }
  await dbDel("projects", id);
  await loadAll();
  toast("專案已刪除");
  backToList();
}

/* ═══════════ 需求紀錄 ═══════════ */
const MAX_ATTACHMENT_BYTES = 700 * 1024;
function splitBySize(files){
  const ok = [], big = [];
  files.forEach(f => (f.size > MAX_ATTACHMENT_BYTES ? big : ok).push(f));
  return { ok, big };
}
function warnOversized(big){
  if(big.length) toast(`${big.map(f => f.name).join("、")} 超過 700KB，無法上傳`);
}
function addDraftImages(files){
  const { ok, big } = splitBySize(files);
  ok.forEach(f => state.draftImages.push({ id: uid(), blob: f, name: f.name || "貼上的圖片" }));
  renderDraftThumbs();
  warnOversized(big);
}
function renderDraftThumbs(){
  const box = $("#r-thumbs");
  if(!box) return;
  box.innerHTML = state.draftImages.map(im => `
    <div class="thumb">
      <img src="${objectUrl(im.id, im.blob)}" alt="${esc(im.name)}" style="cursor:pointer" data-viewimg="${im.id}">
      <button class="thumb__x" type="button" data-drop="${im.id}" aria-label="移除 ${esc(im.name)}">✕</button>
    </div>`).join("");
  $$("[data-viewimg]", box).forEach(b => b.addEventListener("click", () => {
    const im = state.draftImages.find(x => x.id === b.dataset.viewimg);
    if(im) openImagePreview(im);
  }));
  $$("[data-drop]", box).forEach(b => b.addEventListener("click", () => {
    state.draftImages = state.draftImages.filter(x => x.id !== b.dataset.drop);
    renderDraftThumbs();
  }));
}

function addDraftFiles(files){
  const { ok, big } = splitBySize(files);
  ok.forEach(f => state.draftFiles.push({ id: uid(), blob: f, name: f.name || "檔案" }));
  renderDraftFiles();
  warnOversized(big);
}
function renderDraftFiles(){
  const box = $("#r-filelist");
  if(!box) return;
  box.innerHTML = state.draftFiles.map(f => `
    <span class="filechip">
      <button class="filechip__name" type="button" data-previewfile="${f.id}" title="預覽 ${esc(f.name)}">📎 ${esc(f.name)}</button>
      <button class="filechip__x" type="button" data-dropfile="${f.id}" aria-label="移除 ${esc(f.name)}">✕</button>
    </span>`).join("");
  $$("[data-previewfile]", box).forEach(b => b.addEventListener("click", () => {
    const f = state.draftFiles.find(x => x.id === b.dataset.previewfile);
    if(f) openFilePreview(f);
  }));
  $$("[data-dropfile]", box).forEach(b => b.addEventListener("click", () => {
    state.draftFiles = state.draftFiles.filter(x => x.id !== b.dataset.dropfile);
    renderDraftFiles();
  }));
}

function resetReqForm(){
  state.editingReqId = null;
  state.draftImages = [];
  state.draftFiles = [];
  if($("#r-content")) $("#r-content").value = "";
  if($("#r-date")) $("#r-date").value = new Date().toISOString().slice(0,10);
  if($("#r-source")) $("#r-source").value = defaultSourceId();
  if($("#req-submit")) $("#req-submit").textContent = "新增需求";
  if($("#req-cancel")) $("#req-cancel").hidden = true;
  renderDraftThumbs();
  renderDraftFiles();
}

async function startEditReq(id){
  const r = state.reqs.find(x => x.id === id);
  if(!r) return;
  state.editingReqId = id;
  $("#r-date").value = r.date;
  $("#r-source").value = r.sourceContactId || "";
  $("#r-content").value = r.content || "";
  state.draftImages = [];
  for(const imgId of (r.images || [])){
    const rec = await dbGet("images", imgId);
    if(rec) state.draftImages.push({ id: rec.id, blob: rec.blob, name: rec.name });
  }
  renderDraftThumbs();
  state.draftFiles = [];
  for(const fileId of (r.files || [])){
    const rec = await dbGet("files", fileId);
    if(rec) state.draftFiles.push({ id: rec.id, blob: rec.blob, name: rec.name });
  }
  renderDraftFiles();
  $("#req-submit").textContent = "更新需求";
  $("#req-cancel").hidden = false;
  $("#r-content").focus();
  $("#r-content").scrollIntoView({ block:"center" });
}

async function saveRequirement(projectId){
  const content = $("#r-content").value.trim();
  if(!content && !state.draftImages.length && !state.draftFiles.length){
    toast("請輸入內容或加入圖片、檔案"); $("#r-content").focus(); return;
  }

  const imageIds = [];
  for(const im of state.draftImages){
    await dbPut("images", { id: im.id, blob: im.blob, name: im.name, type: im.blob.type });
    imageIds.push(im.id);
  }
  const fileIds = [];
  for(const f of state.draftFiles){
    await dbPut("files", { id: f.id, blob: f.blob, name: f.name, type: f.blob.type });
    fileIds.push(f.id);
  }

  const srcId = $("#r-source").value;
  const srcName = srcId ? (state.contacts.find(c => c.id === srcId)?.name || "") : "";

  if(state.editingReqId){
    const r = state.reqs.find(x => x.id === state.editingReqId);
    for(const old of (r.images || [])) if(!imageIds.includes(old)) await dbDel("images", old);
    for(const old of (r.files || [])) if(!fileIds.includes(old)) await dbDel("files", old);
    await dbPut("reqs", {
      ...r,
      date: $("#r-date").value || r.date,
      sourceContactId: srcId, sourceName: srcName,
      content, images: imageIds, files: fileIds, updatedAt: Date.now(),
    });
    toast("需求已更新");
  } else {
    await dbPut("reqs", {
      id: uid(), projectId,
      date: $("#r-date").value || new Date().toISOString().slice(0,10),
      sourceContactId: srcId, sourceName: srcName,
      content, images: imageIds, files: fileIds, done: false, createdAt: Date.now(),
    });
    toast("需求已新增");
  }

  const p = state.projects.find(x => x.id === projectId);
  if(p){ p.updatedAt = Date.now(); await dbPut("projects", p); }
  resetReqForm();
  await loadAll();
  await renderTimeline(projectId);
}

async function renderTimeline(projectId){
  const box = $("#timeline");
  if(!box) return;
  const all = state.reqs.filter(r => r.projectId === projectId)
    .sort((a,b) => (b.date || "").localeCompare(a.date || "") || b.createdAt - a.createdAt);
  const open = all.filter(r => !r.done).length;
  const summary = $("#req-summary");
  if(summary) summary.textContent = all.length ? `未完成 ${open} ／ 共 ${all.length}` : "";
  const list = state.reqOnlyOpen ? all.filter(r => !r.done) : all;

  if(!all.length){
    box.innerHTML = `<div class="empty" style="padding:36px 20px">
      <p class="empty__title">還沒有需求紀錄</p>
      <p class="empty__body">老闆或客戶傳來的修改需求記在這裡，附上截圖就不會忘記細節。</p></div>`;
    return;
  }
  if(!list.length){
    box.innerHTML = `<div class="empty" style="padding:36px 20px">
      <p class="empty__title">全部都完成了</p>
      <p class="empty__body">取消勾選「只看未完成」就能看到歷史紀錄。</p></div>`;
    return;
  }

  const parts = [];
  for(const r of list){
    const src = reqSource(r);
    let thumbs = "";
    for(const imgId of (r.images || [])){
      const rec = await dbGet("images", imgId);
      if(!rec) continue;
      thumbs += `<button class="thumb thumb--btn" type="button" data-img="${imgId}" aria-label="放大檢視 ${esc(rec.name)}">
        <img src="${objectUrl(imgId, rec.blob)}" alt="${esc(rec.name)}"></button>`;
    }
    let fileChips = "";
    for(const fileId of (r.files || [])){
      const rec = await dbGet("files", fileId);
      if(!rec) continue;
      fileChips += `<span class="filechip">
        <button class="filechip__name" type="button" data-previewfile="${fileId}" title="預覽 ${esc(rec.name)}">📎 ${esc(rec.name)}</button>
        <a class="filechip__dl" href="${objectUrl(fileId, rec.blob)}" download="${esc(rec.name)}" aria-label="下載 ${esc(rec.name)}" title="下載">⭳</a>
      </span>`;
    }
    parts.push(`
      <div class="tl-item ${r.done ? "tl-item--done" : ""}">
        <div class="tl-head">
          <span class="tl-date">${esc(r.date)}</span>
          <span class="tag ${src.cls}">${esc(src.label)}</span>
          <span class="tl-tools">
            <button class="btn btn--sm btn--ghost" type="button" data-editreq="${r.id}">編輯</button>
            <button class="btn btn--sm btn--ghost" type="button" data-toggle="${r.id}">${r.done ? "改回未完成" : "標記完成"}</button>
            <button class="btn btn--sm btn--ghost" type="button" data-delreq="${r.id}" aria-label="刪除這筆需求">刪除</button>
          </span>
        </div>
        ${r.content ? `<div class="tl-body">${esc(r.content)}</div>` : ""}
        ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ""}
        ${fileChips ? `<div class="filelist">${fileChips}</div>` : ""}
      </div>`);
  }
  box.innerHTML = `<div class="timeline">${parts.join("")}</div>`;

  $$("[data-editreq]", box).forEach(b => b.addEventListener("click", () => startEditReq(b.dataset.editreq)));
  $$("[data-toggle]", box).forEach(b => b.addEventListener("click", async () => {
    const r = state.reqs.find(x => x.id === b.dataset.toggle);
    r.done = !r.done;
    await dbPut("reqs", r);
    await loadAll();
    await renderTimeline(projectId);
  }));
  $$("[data-delreq]", box).forEach(b => b.addEventListener("click", () => {
    openConfirm("確定要刪除這筆需求紀錄嗎？附加的圖片和檔案也會一起移除。", async () => {
      const r = state.reqs.find(x => x.id === b.dataset.delreq);
      for(const imgId of (r.images || [])) await dbDel("images", imgId);
      for(const fileId of (r.files || [])) await dbDel("files", fileId);
      await dbDel("reqs", r.id);
      if(state.editingReqId === r.id) resetReqForm();
      await loadAll();
      await renderTimeline(projectId);
      toast("需求已刪除");
    });
  }));
  $$("[data-img]", box).forEach(b => b.addEventListener("click", async () => {
    const rec = await dbGet("images", b.dataset.img);
    if(rec) openImagePreview(rec);
  }));
  $$("[data-previewfile]", box).forEach(b => b.addEventListener("click", async () => {
    const rec = await dbGet("files", b.dataset.previewfile);
    if(rec) openFilePreview(rec);
  }));
}

/* ═══════════ 聯絡窗口 ═══════════ */
let editingContactId = null;
let contactReturnTarget = null;

function renderContacts(){
  const body = $("#contacts-body");
  if(!state.contacts.length){
    body.innerHTML = `<div class="empty" style="padding:32px 12px">
      <p class="empty__title">還沒有聯絡窗口</p>
      <p class="empty__body">先把常合作的窗口建起來，之後在專案裡直接選就好，電話信箱不用再重打一次。</p></div>`;
    return;
  }
  body.innerHTML = `<div class="clist">${state.contacts.map(c => {
    const used = contactUseCount(c.id);
    const meta = [c.phone, c.email].filter(Boolean).join("　·　");
    return `<div class="crow">
      <div class="crow__main">
        <div><span class="crow__name">${esc(c.name)}</span>${c.title ? ` <span class="crow__org">${esc(c.title)}</span>` : ""}</div>
        ${c.org ? `<div class="crow__org">${esc(c.org)}</div>` : ""}
        ${meta ? `<div class="crow__meta">${esc(meta)}</div>` : ""}
      </div>
      <span class="crow__used">${used} 個專案</span>
      <span class="crow__tools">
        <button class="btn btn--sm btn--ghost" type="button" data-cedit="${c.id}">編輯</button>
        <button class="btn btn--sm btn--ghost" type="button" data-cdel="${c.id}" aria-label="刪除 ${esc(c.name)}">刪除</button>
      </span>
    </div>`;
  }).join("")}</div>`;

  $$("[data-cedit]", body).forEach(b => b.addEventListener("click", () => openContactForm(b.dataset.cedit, null)));
  $$("[data-cdel]", body).forEach(b => b.addEventListener("click", () => {
    const c = state.contacts.find(x => x.id === b.dataset.cdel);
    const used = contactUseCount(c.id);
    const cited = state.reqs.filter(r => r.sourceContactId === c.id).length;
    const parts = [];
    if(used)  parts.push(`${used} 個專案的聯絡窗口會變成未指定`);
    if(cited) parts.push(`${cited} 筆需求紀錄會標示為「${c.name}（已移除）」`);
    const msg = parts.length
      ? `刪除「${c.name}」之後，${parts.join("，")}。此動作無法復原，要繼續嗎？`
      : `確定要刪除「${c.name}」嗎？此動作無法復原。`;
    openConfirm(msg, async () => {
      for(const p of state.projects.filter(p => p.contactId === c.id)){
        p.contactId = ""; p.updatedAt = Date.now();
        await dbPut("projects", p);
      }
      await dbDel("contacts", c.id);
      await loadAll();
      renderContacts();
      if(state.currentId) openDetail(state.currentId); else renderList();
      toast("窗口已刪除");
    });
  }));
}

function openContactForm(id, target){
  editingContactId = id || null;
  contactReturnTarget = target || null;
  const c = id ? state.contacts.find(x => x.id === id) : null;
  const f = $("#form-contact");
  $("#dlg-contact-title").textContent = c ? "編輯窗口" : "新增窗口";
  f.reset();
  if(c){
    f.elements.name.value = c.name || "";
    f.elements.org.value = c.org || "";
    f.elements.title.value = c.title || "";
    f.elements.phone.value = c.phone || "";
    f.elements.email.value = c.email || "";
    f.elements.note.value = c.note || "";
  }
  $("#dlg-contact").showModal();
  setTimeout(() => f.elements.name.focus(), 40);
}

$("#form-contact").addEventListener("submit", async e => {
  const f = e.target;
  if(!f.elements.name.value.trim()){ e.preventDefault(); return; }
  const now = Date.now();
  const base = editingContactId ? state.contacts.find(c => c.id === editingContactId) : { id: uid(), createdAt: now };
  const rec = {
    ...base,
    name: f.elements.name.value.trim(),
    org: f.elements.org.value.trim(),
    title: f.elements.title.value.trim(),
    phone: f.elements.phone.value.trim(),
    email: f.elements.email.value.trim(),
    note: f.elements.note.value.trim(),
    updatedAt: now,
  };
  await dbPut("contacts", rec);
  await loadAll();
  toast(editingContactId ? "窗口已更新" : "窗口已建立");

  if(contactReturnTarget === "project" && $("#dlg-project").open){
    fillContactSelect(rec.id);
  } else if(contactReturnTarget === "req" && $("#r-source")){
    $("#r-source").innerHTML = sourceOptions(rec.id);
    $("#r-source").value = rec.id;
  } else {
    if($("#dlg-contacts").open) renderContacts();
    if(state.currentId) openDetail(state.currentId); else renderList();
  }
});

$("#btn-contacts").addEventListener("click", () => { renderContacts(); $("#dlg-contacts").showModal(); });
$("#btn-new-contact").addEventListener("click", () => openContactForm(null, null));
$("#btn-add-contact").addEventListener("click", () => openContactForm(null, "project"));

/* ═══════════ Markdown ═══════════ */
const MD_FIELD = {
  "狀態":"status", "業務":"client", "客戶":"client", "窗口":"__contact", "聯絡窗口":"__contact",
  "網域":"domain", "正式網域":"domain", "測試站":"testUrl", "測試站網址":"testUrl",
  "後台":"adminUrl", "後台網址":"adminUrl", "主機":"host", "主機商":"host",
  "FTP":"ftpHost", "FTP位址":"ftpHost", "FTP帳號":"ftpUser",
  "密碼位置":"ftpNote", "密碼存放位置":"ftpNote",
  "上線日":"launchDate", "上線日期":"launchDate",
  "到期日":"expiryDate", "維護到期日":"expiryDate",
  "標籤":"tags", "備註":"note",
};
const MD_CONTACT = { "姓名":"name", "單位":"org", "所屬單位":"org", "職稱":"title", "電話":"phone", "信箱":"email", "備註":"note" };
const MD_PROJECT_COL = Object.assign({ "專案名稱":"name", "名稱":"name" }, MD_FIELD);

function statusKeyByLabel(v){
  const t = String(v || "").trim();
  const s = STATUSES.find(x => x.label === t || x.key === t);
  return s ? s.key : "doing";
}

function toMarkdown(){
  const L = [];
  if(state.contacts.length){
    L.push("# 聯絡窗口", "");
    L.push("| 姓名 | 所屬單位 | 職稱 | 電話 | 信箱 | 備註 |");
    L.push("|---|---|---|---|---|---|");
    state.contacts.forEach(c => L.push(
      `| ${c.name} | ${c.org||""} | ${c.title||""} | ${c.phone||""} | ${c.email||""} | ${(c.note||"").replace(/\n/g," ")} |`));
    L.push("");
  }
  L.push("# 專案", "");
  state.projects.forEach(p => {
    const ct = contactOf(p);
    L.push(`## ${p.name}`);
    const row = (k, v) => { if(v) L.push(`- ${k}: ${v}`); };
    row("狀態", statusOf(p.status).label);
    row("業務", p.client);
    row("窗口", ct && ct.name);
    row("網域", p.domain);
    row("測試站", p.testUrl);
    row("後台", p.adminUrl);
    row("主機", p.host);
    row("FTP位址", p.ftpHost);
    row("FTP帳號", p.ftpUser);
    row("密碼位置", p.ftpNote);
    row("上線日", p.launchDate);
    row("到期日", p.expiryDate);
    row("標籤", (p.tags || []).join(", "));
    row("備註", (p.note || "").replace(/\n/g, " "));
    const rs = state.reqs.filter(r => r.projectId === p.id)
      .sort((a,b) => (a.date||"").localeCompare(b.date||""));
    if(rs.length){
      L.push("", "### 需求");
      rs.forEach(r => {
        const c = r.sourceContactId ? state.contacts.find(x => x.id === r.sourceContactId) : null;
        const who = r.sourceContactId ? ` @${(c ? c.name : r.sourceName || "").replace(/\s/g,"")}` : "";
        const imgs = (r.images || []).length ? `（附圖 ${r.images.length} 張，需用 JSON 備份）` : "";
        const docs = (r.files || []).length ? `（附檔 ${r.files.length} 個，需用 JSON 備份）` : "";
        L.push(`- [${r.done ? "x" : " "}] ${r.date}${who} ${(r.content||"").replace(/\n/g," ")}${imgs}${docs}`);
      });
    }
    L.push("");
  });
  return L.join("\n").trim() + "\n";
}

function readTable(lines, i){
  const cells = s => s.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(x => x.trim());
  const headers = cells(lines[i]).map(h => h.replace(/\s+/g, ""));
  let j = i + 1;
  if(j < lines.length && /^\|?[\s:|-]+$/.test(lines[j].trim().replace(/\|/g, "|"))) j++;
  const rows = [];
  while(j < lines.length && lines[j].trim().startsWith("|")){ rows.push(cells(lines[j])); j++; }
  return { headers, rows, next: j };
}

function parseMarkdown(text){
  const lines = String(text).replace(/\r/g, "").split("\n");
  const out = { contacts: [], projects: [] };
  let section = "projects", cur = null, inReq = false;

  for(let i = 0; i < lines.length; i++){
    const line = lines[i].trim();
    if(!line) continue;

    if(/^#\s/.test(line)){
      section = /窗口|聯絡人/.test(line) ? "contacts" : "projects";
      cur = null; inReq = false; continue;
    }
    if(/^###\s/.test(line)){ inReq = true; continue; }
    if(/^##\s/.test(line)){
      cur = { name: line.replace(/^##\s*/, "").trim(), fields: {}, reqs: [] };
      out.projects.push(cur); inReq = false; continue;
    }
    if(line.startsWith("|")){
      const { headers, rows, next } = readTable(lines, i);
      i = next - 1;
      if(section === "contacts"){
        rows.forEach(r => {
          const o = {};
          headers.forEach((h, k) => { const f = MD_CONTACT[h]; if(f) o[f] = r[k] || ""; });
          if(o.name) out.contacts.push(o);
        });
      } else {
        rows.forEach(r => {
          const o = { name: "", fields: {}, reqs: [] };
          headers.forEach((h, k) => {
            const f = MD_PROJECT_COL[h];
            if(!f) return;
            if(f === "name") o.name = r[k] || "";
            else if(r[k]) o.fields[f] = r[k];
          });
          if(o.name) out.projects.push(o);
        });
      }
      continue;
    }
    if(!/^[-*]\s/.test(line)) continue;
    const body = line.replace(/^[-*]\s*/, "");

    if(inReq && cur){
      const done = /^\[[xX]\]/.test(body);
      let rest = body.replace(/^\[[\sxX]?\]\s*/, "");
      let date = "";
      const dm = rest.match(/^(\d{4}-\d{1,2}-\d{1,2})\s*/);
      if(dm){ date = dm[1]; rest = rest.slice(dm[0].length); }
      let who = "";
      const wm = rest.match(/^@(\S+)\s*/);
      if(wm){ who = wm[1]; rest = rest.slice(wm[0].length); }
      if(rest.trim()) cur.reqs.push({ done, date, who, content: rest.trim() });
      continue;
    }
    if(cur){
      const m = body.match(/^([^:：]+)[:：]\s*(.*)$/);
      if(!m) continue;
      const f = MD_FIELD[m[1].trim().replace(/\s+/g, "")];
      if(f) cur.fields[f] = m[2].trim();
    }
  }
  return out;
}

async function importMarkdown(text){
  const parsed = parseMarkdown(text);
  if(!parsed.contacts.length && !parsed.projects.length)
    return { error: "沒有解析到任何專案或窗口，請確認格式" };

  const now = Date.now();
  const r = { cNew:0, cUpd:0, pNew:0, pUpd:0, rNew:0 };

  for(const c of parsed.contacts){
    const ex = state.contacts.find(x => x.name === c.name);
    if(ex){ await dbPut("contacts", { ...ex, ...c, updatedAt: now }); r.cUpd++; }
    else {
      await dbPut("contacts", { id: uid(), name: c.name, org: c.org||"", title: c.title||"",
        phone: c.phone||"", email: c.email||"", note: c.note||"", createdAt: now, updatedAt: now });
      r.cNew++;
    }
  }
  await loadAll();

  for(const p of parsed.projects){
    const patch = {};
    for(const [k, v] of Object.entries(p.fields || {})){
      if(k === "__contact"){
        const c = state.contacts.find(x => x.name === String(v).trim());
        if(c) patch.contactId = c.id;
      }
      else if(k === "status") patch.status = statusKeyByLabel(v);
      else if(k === "tags") patch.tags = String(v).split(/[,，]/).map(s => s.trim()).filter(Boolean);
      else patch[k] = v;
    }
    const ex = state.projects.find(x => x.name === p.name);
    let rec;
    if(ex){ rec = { ...ex, ...patch, updatedAt: now }; r.pUpd++; }
    else {
      rec = { id: uid(), name: p.name, status: "doing", client: "", contactId: "",
        domain: "", testUrl: "", adminUrl: "", host: "", ftpHost: "", ftpUser: "", ftpNote: "",
        launchDate: "", expiryDate: "", tags: [], note: "", createdAt: now, updatedAt: now, ...patch };
      r.pNew++;
    }
    await dbPut("projects", rec);

    for(const q of (p.reqs || [])){
      if(state.reqs.some(x => x.projectId === rec.id && x.date === q.date && x.content === q.content)) continue;
      const c = q.who ? state.contacts.find(x => x.name === q.who) : null;
      await dbPut("reqs", {
        id: uid(), projectId: rec.id,
        date: q.date || new Date().toISOString().slice(0,10),
        sourceContactId: c ? c.id : "", sourceName: c ? c.name : "",
        content: q.content, images: [], files: [], done: !!q.done, createdAt: now,
      });
      r.rNew++;
    }
    await loadAll();
  }
  return r;
}

$("#btn-md").addEventListener("click", () => {
  $("#md-status").textContent = "";
  $("#md-text").value = "";
  $("#dlg-md").showModal();
});
$("#md-fill").addEventListener("click", () => {
  $("#md-text").value = toMarkdown();
  $("#md-status").textContent = `已帶入 ${state.projects.length} 個專案、${state.contacts.length} 位窗口`;
});
$("#md-copy").addEventListener("click", async () => {
  const t = $("#md-text").value;
  if(!t.trim()){ $("#md-status").textContent = "內容是空的"; return; }
  try { await navigator.clipboard.writeText(t); $("#md-status").textContent = "已複製到剪貼簿"; }
  catch { $("#md-text").select(); $("#md-status").textContent = "請按 Ctrl+C 複製"; }
});
$("#md-download").addEventListener("click", () => {
  const t = $("#md-text").value || toMarkdown();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([t], { type: "text/markdown" }));
  a.download = `project-desk-${new Date().toISOString().slice(0,10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});
$("#md-import").addEventListener("click", async () => {
  const t = $("#md-text").value;
  if(!t.trim()){ $("#md-status").textContent = "請先貼上內容"; return; }
  $("#md-status").textContent = "解析中⋯";
  const r = await importMarkdown(t);
  if(r.error){ $("#md-status").textContent = r.error; return; }
  const parts = [];
  if(r.pNew) parts.push(`新增 ${r.pNew} 個專案`);
  if(r.pUpd) parts.push(`更新 ${r.pUpd} 個專案`);
  if(r.cNew) parts.push(`新增 ${r.cNew} 位窗口`);
  if(r.cUpd) parts.push(`更新 ${r.cUpd} 位窗口`);
  if(r.rNew) parts.push(`新增 ${r.rNew} 筆需求`);
  $("#md-status").textContent = parts.length ? parts.join("、") : "沒有變更（內容與現有資料相同）";
  toast(parts.length ? "Markdown 匯入完成" : "沒有需要更新的資料");
  if(state.currentId) openDetail(state.currentId); else renderList();
});

/* ═══════════ 匯出 / 匯入 ═══════════ */
function blobToDataUrl(blob){
  return new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
}
async function dataUrlToBlob(url){ return (await fetch(url)).blob(); }

$("#btn-export").addEventListener("click", async () => {
  const images = await dbAll("images");
  const packed = [];
  for(const im of images) packed.push({ id: im.id, name: im.name, type: im.type, data: await blobToDataUrl(im.blob) });
  const files = await dbAll("files");
  const packedFiles = [];
  for(const f of files) packedFiles.push({ id: f.id, name: f.name, type: f.type, data: await blobToDataUrl(f.blob) });
  const payload = {
    app: "project-desk", version: 3, exportedAt: new Date().toISOString(),
    projects: state.projects, reqs: state.reqs, contacts: state.contacts, images: packed, files: packedFiles,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `project-desk-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`已匯出 ${state.projects.length} 個專案`);
});

$("#btn-import").addEventListener("click", () => $("#file-import").click());
$("#file-import").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if(!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { toast("這個檔案讀不了，請確認是 Project Desk 匯出的 JSON"); return; }
  if(data.app !== "project-desk" || !Array.isArray(data.projects)){
    toast("檔案格式不符，請選擇 Project Desk 匯出的備份"); return;
  }
  openConfirm(`即將匯入 ${data.projects.length} 個專案，並覆蓋目前全部資料。建議先匯出一份現有備份。要繼續嗎？`, async () => {
    await dbClear("projects"); await dbClear("reqs"); await dbClear("images"); await dbClear("files"); await dbClear("contacts");
    for(const p of data.projects) await dbPut("projects", p);
    for(const c of (data.contacts || [])) await dbPut("contacts", c);
    for(const r of (data.reqs || [])) await dbPut("reqs", r);
    for(const im of (data.images || []))
      await dbPut("images", { id: im.id, name: im.name, type: im.type, blob: await dataUrlToBlob(im.data) });
    for(const f of (data.files || []))
      await dbPut("files", { id: f.id, name: f.name, type: f.type, blob: await dataUrlToBlob(f.data) });
    urlCache.forEach(u => URL.revokeObjectURL(u));
    urlCache.clear();
    await loadAll();
    backToList();
    toast(`已匯入 ${data.projects.length} 個專案`);
  });
});

/* ═══════════ 啟動 ═══════════ */
(async function init(){
  if(!FIREBASE_READY){
    $("#list-sheet").innerHTML = `<div class="sheet empty">
      <p class="empty__title">尚未設定雲端資料庫</p>
      <p class="empty__body">請先建立 Firebase 專案，並把程式碼中的 FIREBASE_CONFIG 換成你專案的設定值，步驟見 README。</p></div>`;
    return;
  }
  try {
    await loadAll();
    renderList();
    subscribeRealtime();
  } catch(err) {
    $("#list-sheet").innerHTML = `<div class="sheet empty">
      <p class="empty__title">無法連線到雲端資料庫</p>
      <p class="empty__body">請確認網路連線，以及 Firebase 專案設定與 Firestore／Storage 權限規則是否正確。</p></div>`;
    console.error(err);
  }
})();
