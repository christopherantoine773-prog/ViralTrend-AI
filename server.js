import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI || `${BASE_URL}/auth/tiktok/callback`;
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "store.json");

const required = ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY", "SESSION_SECRET"];
for (const k of required) {
  if (!process.env[k] || process.env[k].startsWith("replace_with")) {
    console.warn(`Configuration needed: ${k} (OAuth/publishing will not work until configured).`);
  }
}

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
    scriptSrc: ["'self'"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'"]
  }
}}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

const b64key = () => {
  try {
    const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || "", "base64");
    return key.length === 32 ? key : null;
  } catch { return null; }
};
const sign = (value) => crypto.createHmac("sha256", process.env.SESSION_SECRET || "development-only").update(value).digest("hex");
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
function encrypt(value) {
  const key = b64key();
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}
function decrypt(value) {
  const key = b64key();
  if (!key) throw new Error("Token encryption key is not configured.");
  const [ivB64, tagB64, dataB64] = String(value).split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8"));
}
async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { return JSON.parse(await fs.readFile(DB_FILE, "utf8")); }
  catch { return { token: null, profile: null, drafts: [], schedule: [], lastVideos: [], comments: [] }; }
}
async function saveStore(db) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  await fs.rename(tmp, DB_FILE);
}
function setSession(res, id) {
  const value = `${id}.${sign(id)}`;
  res.cookie("vta_session", value, {
    httpOnly: true, sameSite: "lax", secure: BASE_URL.startsWith("https://"),
    maxAge: 30 * 24 * 60 * 60 * 1000, path: "/"
  });
}
function sessionId(req) {
  const value = req.cookies?.vta_session || "";
  const [id, sig] = value.split(".");
  if (!id || !sig || !safeEqual(sig, sign(id))) return null;
  return id;
}
function requireSession(req, res, next) {
  const id = sessionId(req);
  if (!id) return res.status(401).json({ error: "Connecte ton compte TikTok pour continuer." });
  req.sessionId = id;
  next();
}
function assertConfig() {
  if (required.some(k => !process.env[k] || process.env[k].startsWith("replace_with"))) {
    throw new Error("Configure les clés TikTok et les secrets dans le fichier .env.");
  }
}
async function apiToken() {
  const db = await loadStore();
  if (!db.token) throw new Error("Compte TikTok non connecté.");
  let token = decrypt(db.token);
  if (Date.now() > (token.expires_at || 0) - 120_000) {
    if (!token.refresh_token) throw new Error("Jeton expiré : reconnecte TikTok.");
    const body = new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: token.refresh_token
    });
    const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error("Renouvellement TikTok impossible. Reconnecte ton compte.");
    token = { ...token, ...j, expires_at: Date.now() + Number(j.expires_in || 86400) * 1000 };
    db.token = encrypt(token);
    await saveStore(db);
  }
  return token;
}
async function tiktokFetch(url, token, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error?.code && j.error.code !== "ok") {
    const msg = j.error?.message || j.message || `TikTok API error (${r.status})`;
    throw new Error(msg);
  }
  return j;
}
const jsonError = (res, e) => res.status(400).json({ error: e?.message || "Une erreur est survenue." });

app.get("/api/status", async (req, res) => {
  const db = await loadStore();
  const connected = Boolean(db.token && sessionId(req));
  res.json({
    configured: required.every(k => process.env[k] && !process.env[k].startsWith("replace_with")),
    connected,
    profile: connected ? db.profile : null,
    scope: connected ? (decrypt(db.token).scope || "") : "",
    drafts: connected ? db.drafts : [],
    schedule: connected ? db.schedule : [],
    videos: connected ? db.lastVideos : [],
    comments: connected ? db.comments : []
  });
});

app.get("/auth/tiktok", (req, res) => {
  try {
    assertConfig();
    const state = crypto.randomBytes(24).toString("hex");
    res.cookie("vta_oauth_state", state, {
      httpOnly: true, sameSite: "lax", secure: BASE_URL.startsWith("https://"), maxAge: 10 * 60 * 1000, path: "/"
    });
    const scopes = ["user.info.basic", "user.info.stats", "video.list", "video.publish"].join(",");
    const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
    u.search = new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      response_type: "code",
      scope: scopes,
      redirect_uri: REDIRECT_URI,
      state
    }).toString();
    res.redirect(u.toString());
  } catch (e) { res.redirect(`/?error=${encodeURIComponent(e.message)}`); }
});

app.get("/auth/tiktok/callback", async (req, res) => {
  try {
    const expected = req.cookies?.vta_oauth_state;
    res.clearCookie("vta_oauth_state", { path: "/" });
    if (!expected || !safeEqual(expected, req.query.state)) throw new Error("État OAuth invalide. Réessaie la connexion.");
    if (req.query.error) throw new Error("Connexion TikTok refusée ou annulée.");
    if (!req.query.code) throw new Error("Code d'autorisation absent.");
    assertConfig();
    const body = new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code: String(req.query.code),
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI
    });
    const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body
    });
    const tok = await r.json();
    if (!r.ok || tok.error) throw new Error(tok.error_description || "Échange du jeton TikTok échoué.");
    tok.expires_at = Date.now() + Number(tok.expires_in || 86400) * 1000;
    const info = await tiktokFetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,likes_count,follower_count,following_count,video_count",
      tok.access_token
    );
    const db = await loadStore();
    db.token = encrypt(tok);
    db.profile = info.data?.user || { open_id: tok.open_id, display_name: "Compte TikTok" };
    await saveStore(db);
    setSession(res, tok.open_id || crypto.randomUUID());
    res.redirect("/?connected=1");
  } catch (e) { res.redirect(`/?error=${encodeURIComponent(e.message)}`); }
});

app.post("/auth/logout", requireSession, async (req, res) => {
  const db = await loadStore();
  try {
    if (db.token) {
      const tok = decrypt(db.token);
      const body = new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY || "",
        client_secret: process.env.TIKTOK_CLIENT_SECRET || "",
        token: tok.access_token || ""
      });
      await fetch("https://open.tiktokapis.com/v2/oauth/revoke/", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body
      });
    }
  } catch {}
  db.token = null; db.profile = null; db.lastVideos = [];
  await saveStore(db);
  res.clearCookie("vta_session", { path: "/" });
  res.json({ ok: true });
});

app.post("/api/refresh", requireSession, async (req, res) => {
  try {
    const tok = await apiToken();
    const db = await loadStore();
    const fields = "id,create_time,cover_image_url,share_url,video_description,title,like_count,comment_count,share_count,view_count";
    const j = await tiktokFetch(`https://open.tiktokapis.com/v2/video/list/?fields=${fields}`, tok.access_token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_count: 20 })
    });
    const videos = j.data?.videos || [];
    const scored = videos.map(v => {
      const views = Number(v.view_count || 0), likes = Number(v.like_count || 0);
      const comments = Number(v.comment_count || 0), shares = Number(v.share_count || 0);
      const engagement = views ? (likes + comments * 2 + shares * 3) / views : 0;
      return { ...v, trend_score: Math.round(Math.min(100, (Math.log10(views + 1) * 9) + engagement * 400)) };
    }).sort((a, b) => b.trend_score - a.trend_score);
    db.lastVideos = scored;
    await saveStore(db);
    res.json({ videos: scored, note: "Classement indicatif calculé à partir des vidéos accessibles sur ton compte, pas une prédiction de viralité future." });
  } catch (e) { jsonError(res, e); }
});

app.post("/api/drafts", requireSession, async (req, res) => {
  const topic = String(req.body.topic || "").trim().slice(0, 300);
  const style = String(req.body.style || "engageant").slice(0, 60);
  if (!topic) return res.status(400).json({ error: "Ajoute un sujet pour générer une légende." });
  const tags = topic.toLowerCase().match(/[a-z0-9À-ÿ]+/g)?.filter(x => x.length > 3).slice(0, 3) || ["tendance"];
  const caption = `${topic}\n\n${style === "question" ? "Tu en penses quoi ? Dis-le en commentaire 👇" : style === "story" ? "Reste jusqu’à la fin et dis-moi ce que tu en retiens." : "Tu valides ou pas ? Donne ton avis en commentaire 👇"}\n\n${tags.map(t => "#" + t.replace(/[^a-z0-9À-ÿ]/gi, "")).join(" ")} #PourToi`;
  const db = await loadStore();
  const draft = { id: crypto.randomUUID(), topic, style, caption, created_at: new Date().toISOString(), status: "draft" };
  db.drafts.unshift(draft);
  db.drafts = db.drafts.slice(0, 100);
  await saveStore(db);
  res.json({ draft });
});

app.post("/api/drafts/custom", requireSession, async (req, res) => {
  const topic = String(req.body.topic || "").trim().slice(0, 300);
  const caption = String(req.body.caption || "").trim().slice(0, 2200);
  const style = String(req.body.style || "personnalisé").slice(0, 60);
  if (!topic || !caption) return res.status(400).json({ error: "Le sujet et la légende sont obligatoires." });
  const db = await loadStore();
  const draft = { id: crypto.randomUUID(), topic, style, caption, created_at: new Date().toISOString(), status: "draft" };
  db.drafts.unshift(draft);
  db.drafts = db.drafts.slice(0, 100);
  await saveStore(db);
  res.json({ draft });
});

app.post("/api/comments/analyze", requireSession, async (req, res) => {
  const raw = String(req.body.comments || "").slice(0, 12000);
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 100);
  const stop = new Set(["pour", "avec", "dans", "cette", "comme", "mais", "donc", "plus", "trop", "très", "vous", "nous", "they", "that", "this", "your", "have", "what", "when", "from", "just"]);
  const items = lines.map((text, i) => {
    const words = (text.toLowerCase().match(/[a-z0-9À-ÿ']+/g) || []).filter(w => w.length > 3 && !stop.has(w));
    const question = text.includes("?");
    const emotion = /😂|😭|🔥|❤️|😍|😮|💀|🤣/.test(text);
    const score = Math.min(100, words.length * 5 + (question ? 15 : 0) + (emotion ? 15 : 0) + (text.length > 35 ? 10 : 0));
    return { text, score, reason: [question ? "question" : "", emotion ? "réaction émotionnelle" : "", words.length > 5 ? "détails concrets" : ""].filter(Boolean).join(", ") || "commentaire court", index: i };
  }).sort((a,b) => b.score - a.score);
  const db = await loadStore();
  db.comments = items.slice(0, 20);
  await saveStore(db);
  res.json({ comments: db.comments, note: "Analyse heuristique des textes que tu as collés. Ce n'est pas un accès direct aux commentaires TikTok." });
});

app.post("/api/schedule", requireSession, async (req, res) => {
  const { draftId, scheduledAt, videoUrl, privacy } = req.body || {};
  const db = await loadStore();
  const draft = db.drafts.find(d => d.id === draftId);
  if (!draft) return res.status(404).json({ error: "Brouillon introuvable." });
  const date = new Date(scheduledAt);
  if (!scheduledAt || Number.isNaN(date.getTime()) || date < new Date()) return res.status(400).json({ error: "Choisis une date future." });
  let url = "";
  if (videoUrl) {
    try {
      const parsed = new URL(videoUrl);
      if (parsed.protocol !== "https:") throw new Error();
      url = parsed.toString();
    } catch { return res.status(400).json({ error: "Le lien vidéo doit être une URL HTTPS valide." }); }
  }
  const item = {
    id: crypto.randomUUID(), draftId, caption: draft.caption, scheduledAt: date.toISOString(),
    videoUrl: url, privacy: privacy || "SELF_ONLY", status: "planned",
    createdAt: new Date().toISOString(), note: "Publication non envoyée. Une confirmation manuelle est requise."
  };
  db.schedule.push(item);
  await saveStore(db);
  res.json({ item });
});

app.post("/api/publish/:id", requireSession, async (req, res) => {
  try {
    const db = await loadStore();
    const item = db.schedule.find(x => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Publication planifiée introuvable." });
    if (!item.videoUrl) return res.status(400).json({ error: "Ajoute l'URL HTTPS de ta vidéo originale hébergée sur un domaine vérifié." });
    if (!["planned", "failed"].includes(item.status)) return res.status(400).json({ error: "Cette publication a déjà été envoyée ou est en cours." });
    const tok = await apiToken();
    const creator = await tiktokFetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", tok.access_token, { method: "POST" });
    const allowed = creator.data?.privacy_level_options || [];
    const privacy = allowed.includes(item.privacy) ? item.privacy : allowed[0];
    if (!privacy) throw new Error("TikTok n'a pas retourné d'option de confidentialité autorisée.");
    // The button click is the explicit user action. The client must show the caption,
    // selected privacy and video URL before calling this endpoint.
    const j = await tiktokFetch("https://open.tiktokapis.com/v2/post/publish/video/init/", tok.access_token, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        post_info: { title: item.caption, privacy_level: privacy, disable_duet: false, disable_comment: false, disable_stitch: false },
        source_info: { source: "PULL_FROM_URL", video_url: item.videoUrl }
      })
    });
    item.status = "submitted";
    item.publishId = j.data?.publish_id || null;
    item.submittedAt = new Date().toISOString();
    item.privacy = privacy;
    item.note = "Envoyé à TikTok. Vérifie le statut dans TikTok ou via l'API de statut.";
    await saveStore(db);
    res.json({ item, publishId: item.publishId, message: "Demande envoyée à TikTok. Cela ne garantit pas que la publication soit déjà visible." });
  } catch (e) {
    const db = await loadStore();
    const item = db.schedule.find(x => x.id === req.params.id);
    if (item) { item.status = "failed"; item.note = e.message; await saveStore(db); }
    jsonError(res, e);
  }
});

app.delete("/api/schedule/:id", requireSession, async (req, res) => {
  const db = await loadStore();
  db.schedule = db.schedule.filter(x => x.id !== req.params.id);
  await saveStore(db);
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => res.json({ ok: true, app: "ViralTrend AI" }));
app.listen(PORT, () => console.log(`ViralTrend AI running on ${BASE_URL}`));
