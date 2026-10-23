const $ = (id) => document.getElementById(id);
let state = { connected: false, profile: null, drafts: [], schedule: [], videos: [], comments: [] };
let pendingPublishId = null;

function notice(message, error = false) {
  const el = $("notice");
  el.textContent = message;
  el.classList.remove("hidden", "error");
  if (error) el.classList.add("error");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function clearNotice() { $("notice").classList.add("hidden"); }
async function api(url, options = {}) {
  const r = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
  return j;
}
function fmt(n) {
  return Number(n || 0).toLocaleString("fr-FR");
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function setConnectedUI() {
  $("connectBtn").classList.toggle("hidden", state.connected);
  $("logoutBtn").classList.toggle("hidden", !state.connected);
  $("accountName").textContent = state.profile?.display_name || (state.connected ? "Compte connecté" : "Compte non connecté");
  $("accountSub").textContent = state.connected ? "Connecté via OAuth officiel" : "Connecte ton compte pour démarrer";
  const avatar = $("accountBox").querySelector(".avatar");
  avatar.innerHTML = state.profile?.avatar_url ? `<img src="${escapeHtml(state.profile.avatar_url)}" alt="">` : "♪";
  $("metricVideos").textContent = state.videos.length ? fmt(state.videos.length) : "—";
  $("metricViews").textContent = state.videos.length ? fmt(state.videos.reduce((s,v)=>s+Number(v.view_count||0),0)) : "—";
  $("metricDrafts").textContent = fmt(state.drafts.length);
  $("metricQueue").textContent = fmt(state.schedule.filter(x=>["planned","failed"].includes(x.status)).length);
  renderVideos(); renderDrafts(); renderSchedule(); fillDraftSelect();
}
async function loadStatus() {
  try {
    const j = await api("/api/status");
    state = { ...state, ...j };
    setConnectedUI();
    if (!j.configured) notice("Configuration requise : crée le fichier .env et renseigne les identifiants TikTok et les secrets avant de connecter ton compte.", true);
    const params = new URLSearchParams(location.search);
    if (params.get("connected")) { notice("Compte TikTok connecté. Tu peux maintenant actualiser les données accessibles."); history.replaceState({}, "", "/"); }
    if (params.get("error")) { notice(params.get("error"), true); history.replaceState({}, "", "/"); }
  } catch (e) { notice(e.message, true); }
}
function renderVideos() {
  const body = $("videosBody");
  if (!state.videos.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">${state.connected ? "Clique sur « Actualiser mes données » pour charger les vidéos accessibles." : "Connecte TikTok puis actualise les données."}</td></tr>`;
    return;
  }
  body.innerHTML = state.videos.map(v => `<tr>
    <td><div class="video-title">${escapeHtml(v.title || v.video_description || "Vidéo TikTok")}</div>${v.share_url ? `<a href="${escapeHtml(v.share_url)}" target="_blank" rel="noopener noreferrer" class="fineprint">Ouvrir sur TikTok ↗</a>` : ""}</td>
    <td>${fmt(v.view_count)}</td><td>${fmt(v.like_count)}</td><td>${fmt(v.comment_count)}</td><td><span class="score">${fmt(v.trend_score)}/100</span></td>
  </tr>`).join("");
}
function renderDrafts() {
  $("draftList").innerHTML = state.drafts.slice(0,5).map(d => `<div class="draft-item"><div><b>${escapeHtml(d.topic)}</b><small>${new Date(d.created_at).toLocaleString("fr-FR")}</small></div><button class="btn ghost small" data-use-draft="${escapeHtml(d.id)}">Utiliser</button></div>`).join("");
  $("draftList").querySelectorAll("[data-use-draft]").forEach(btn => btn.addEventListener("click", () => {
    const d = state.drafts.find(x => x.id === btn.dataset.useDraft);
    if (d) { $("captionOutput").value = d.caption; $("scheduleDraft").value = d.id; }
  }));
}
function fillDraftSelect() {
  const select = $("scheduleDraft"), current = select.value;
  select.innerHTML = `<option value="">Choisis un brouillon</option>` + state.drafts.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.topic)}</option>`).join("");
  if (state.drafts.some(d=>d.id===current)) select.value = current;
}
function renderSchedule() {
  const el = $("scheduleList");
  if (!state.schedule.length) { el.innerHTML = `<div class="results-empty">Aucun contenu planifié. Enregistre une légende puis ajoute-la au calendrier.</div>`; return; }
  el.innerHTML = [...state.schedule].sort((a,b)=>new Date(a.scheduledAt)-new Date(b.scheduledAt)).map(item => `
    <div class="schedule-item"><div><b>${escapeHtml((item.caption||"Publication").split("\n")[0])}</b><small>${new Date(item.scheduledAt).toLocaleString("fr-FR")} · ${escapeHtml(item.privacy)}</small><small>${escapeHtml(item.note||"")}</small><span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></div>
    <div class="schedule-actions">${["planned","failed"].includes(item.status) ? `<button class="btn primary small" data-publish="${escapeHtml(item.id)}">Vérifier et envoyer</button>` : ""}<button class="btn ghost small" data-delete="${escapeHtml(item.id)}">Supprimer</button></div></div>`).join("");
  el.querySelectorAll("[data-publish]").forEach(b=>b.addEventListener("click",()=>openPublishModal(b.dataset.publish)));
  el.querySelectorAll("[data-delete]").forEach(b=>b.addEventListener("click",async()=>{try{await api(`/api/schedule/${b.dataset.delete}`,{method:"DELETE"});await loadStatus();}catch(e){notice(e.message,true);}}));
}
async function refreshVideos() {
  clearNotice();
  $("refreshBtn").disabled = $("refreshBtn2").disabled = true;
  try {
    const j = await api("/api/refresh", { method:"POST", body:"{}" });
    state.videos = j.videos || []; renderVideos(); setConnectedUI();
    notice(j.note || "Données actualisées.");
  } catch(e) { notice(e.message, true); }
  finally { $("refreshBtn").disabled = $("refreshBtn2").disabled = false; }
}
$("connectBtn").addEventListener("click",()=>location.href="/auth/tiktok");
$("logoutBtn").addEventListener("click",async()=>{
  try { await api("/auth/logout",{method:"POST",body:"{}"}); state={connected:false,drafts:[],schedule:[],videos:[],comments:[]}; setConnectedUI(); notice("Compte déconnecté et autorisation révoquée si TikTok l’a acceptée."); }
  catch(e){notice(e.message,true);}
});
$("refreshBtn").addEventListener("click",refreshVideos);
$("refreshBtn2").addEventListener("click",refreshVideos);
$("generateBtn").addEventListener("click",async()=>{
  try {
    const j = await api("/api/drafts",{method:"POST",body:JSON.stringify({topic:$("topic").value,style:$("captionStyle").value})});
    $("captionOutput").value=j.draft.caption; state.drafts.unshift(j.draft); setConnectedUI(); $("scheduleDraft").value=j.draft.id; notice("Légende préparée. Relis-la et adapte-la à ta voix avant publication.");
  } catch(e){notice(e.message,true);}
});
$("saveDraftBtn").addEventListener("click",async()=>{
  const caption = $("captionOutput").value.trim();
  const topic = $("topic").value.trim() || caption.split("\n")[0].slice(0,120);
  if (!topic || !caption) return notice("Écris ou génère une légende avant de l’enregistrer.",true);
  try {
    const j = await api("/api/drafts/custom",{method:"POST",body:JSON.stringify({topic,caption,style:$("captionStyle").value})});
    state.drafts.unshift(j.draft); setConnectedUI(); $("scheduleDraft").value=j.draft.id;
    notice("Brouillon enregistré avec ta légende personnalisée.");
  } catch(e){notice(e.message,true);}
});
$("copyBtn").addEventListener("click",async()=>{
  try { await navigator.clipboard.writeText($("captionOutput").value); notice("Légende copiée."); }
  catch { $("captionOutput").select(); notice("Sélectionne le texte puis copie-le depuis ton appareil."); }
});
$("analyzeBtn").addEventListener("click",async()=>{
  try {
    const j=await api("/api/comments/analyze",{method:"POST",body:JSON.stringify({comments:$("commentsInput").value})});
    state.comments=j.comments||[];
    $("commentsResults").innerHTML=(state.comments.length ? state.comments.map(c=>`<div class="result-item"><div>${escapeHtml(c.text)}<div class="fineprint">${escapeHtml(c.reason)}</div></div><span class="score">${c.score}</span></div>`).join("") : `<div class="results-empty">Colle quelques commentaires pour les analyser.</div>`);
    notice(j.note||"Analyse terminée.");
  }catch(e){notice(e.message,true);}
});
$("scheduleBtn").addEventListener("click",async()=>{
  try {
    const j=await api("/api/schedule",{method:"POST",body:JSON.stringify({
      draftId:$("scheduleDraft").value,scheduledAt:$("scheduleDate").value,
      videoUrl:$("videoUrl").value.trim(),privacy:$("privacy").value
    })});
    state.schedule.push(j.item); setConnectedUI(); notice("Ajouté au calendrier. Rien ne sera publié sans ta confirmation.");
  }catch(e){notice(e.message,true);}
});
function openPublishModal(id) {
  const item=state.schedule.find(x=>x.id===id);
  if(!item)return;
  if(!item.videoUrl) return notice("Ajoute d’abord l’URL HTTPS de ta vidéo originale à cet élément du calendrier.",true);
  pendingPublishId=id;
  $("confirmDetails").innerHTML=`<b>Légende</b><br>${escapeHtml(item.caption)}<br><br><b>Vidéo</b><br>${escapeHtml(item.videoUrl)}<br><br><b>Confidentialité demandée</b><br>${escapeHtml(item.privacy)}<br><br><span class="fineprint">TikTok peut limiter ou refuser cette demande selon les scopes, l’audit de l’application et les réglages du compte.</span>`;
  $("confirmModal").classList.remove("hidden");
}
$("cancelPublish").addEventListener("click",()=>{$("confirmModal").classList.add("hidden");pendingPublishId=null;});
$("confirmPublish").addEventListener("click",async()=>{
  if(!pendingPublishId)return;
  $("confirmPublish").disabled=true;
  try {
    const j=await api(`/api/publish/${pendingPublishId}`,{method:"POST",body:"{}"});
    $("confirmModal").classList.add("hidden");pendingPublishId=null;await loadStatus();notice(j.message||"Demande transmise à TikTok.");
  }catch(e){$("confirmModal").classList.add("hidden");notice(e.message,true);await loadStatus();}
  finally{$("confirmPublish").disabled=false;}
});
loadStatus();
