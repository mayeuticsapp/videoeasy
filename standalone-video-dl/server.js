const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const YTDLP_BIN = path.resolve(__dirname, "bin/yt-dlp");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// --- Cookie files per piattaforme che richiedono login ---
const INSTAGRAM_COOKIES_PATH = "/tmp/instagram_cookies.txt";
const TIKTOK_COOKIES_PATH = "/tmp/tiktok_cookies.txt";

if (process.env.INSTAGRAM_COOKIES) {
  try {
    fs.writeFileSync(INSTAGRAM_COOKIES_PATH, process.env.INSTAGRAM_COOKIES);
    console.log("Cookie Instagram caricati");
  } catch (e) { console.error("Errore cookie Instagram:", e.message); }
}

if (process.env.TIKTOK_COOKIES) {
  try {
    fs.writeFileSync(TIKTOK_COOKIES_PATH, process.env.TIKTOK_COOKIES);
    console.log("Cookie TikTok caricati");
  } catch (e) { console.error("Errore cookie TikTok:", e.message); }
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// --- Database ---

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  pool.query(`
    CREATE TABLE IF NOT EXISTS video_downloads (
      id SERIAL PRIMARY KEY,
      url TEXT,
      platform TEXT,
      title TEXT,
      success BOOLEAN,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS page_visits (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).then(() => console.log("DB pronto")).catch((e) => console.error("DB init error:", e.message));
}

async function logDownload(url, platform, title, success, error = null) {
  if (!pool) return;
  try {
    await pool.query(
      "INSERT INTO video_downloads (url, platform, title, success, error) VALUES ($1, $2, $3, $4, $5)",
      [url, platform || "unknown", title || "", success, error]
    );
  } catch (e) {
    console.error("DB log error:", e.message);
  }
}

// --- Helpers ---

function detectPlatform(url) {
  if (/youtu\.?be|youtube\.com/i.test(url)) return "YouTube";
  if (/instagram\.com/i.test(url)) return "Instagram";
  if (/tiktok\.com/i.test(url)) return "TikTok";
  if (/facebook\.com|fb\.watch/i.test(url)) return "Facebook";
  if (/twitter\.com|x\.com/i.test(url)) return "Twitter/X";
  if (/vimeo\.com/i.test(url)) return "Vimeo";
  if (/reddit\.com/i.test(url)) return "Reddit";
  return "Altro";
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const bin = fs.existsSync(YTDLP_BIN) ? YTDLP_BIN : "yt-dlp";
    const proc = spawn(bin, args);
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else {
        const errorLine =
          stderr.split("\n").filter((l) => l.includes("ERROR")).pop() ||
          stderr.slice(-400);
        reject(new Error(errorLine.replace(/^.*ERROR:\s*/, "")));
      }
    });
  });
}

function cleanSubtitles(raw) {
  const lines = raw.split("\n");
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("WEBVTT")) continue;
    if (trimmed.startsWith("NOTE")) continue;
    if (/^\d{2}:\d{2}/.test(trimmed)) continue;
    if (/^-->/.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    const clean = trimmed
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result.join("\n");
}

function friendlyError(msg) {
  if (!msg) return "Errore sconosciuto";
  if (msg.includes("429") || msg.toLowerCase().includes("too many requests"))
    return "Troppe richieste. Aspetta 30 secondi e riprova.";
  if (msg.toLowerCase().includes("log in") || msg.toLowerCase().includes("login") || msg.toLowerCase().includes("--cookies"))
    return "Contenuto non accessibile: richiede accesso all'account. Funziona solo con post pubblici (non Stories, non profili privati).";
  if (msg.toLowerCase().includes("private") || msg.toLowerCase().includes("sign in") || msg.toLowerCase().includes("bot"))
    return "YouTube ha bloccato il server. Riprova tra qualche minuto.";
  if (msg.toLowerCase().includes("no video formats"))
    return "Nessun formato video disponibile.";
  if (msg.includes("302") || msg.toLowerCase().includes("redirect loop"))
    return "Impossibile accedere al video. Il link potrebbe richiedere login oppure non è pubblico.";
  if (msg.toLowerCase().includes("age") || msg.toLowerCase().includes("restricted"))
    return "Video non disponibile: soggetto a restrizioni di età.";
  return msg;
}

const YOUTUBE_ARGS = [
  "--extractor-args", "youtube:player_client=ios,web",
  "--user-agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];

// Client TV — meno bloccato di iOS per download audio su server cloud
const YOUTUBE_TX_ARGS = [
  "--extractor-args", "youtube:player_client=tv_embedded,ios,web",
  "--user-agent", "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1",
  "--geo-bypass",
  "--socket-timeout", "30",
];

const FACEBOOK_TX_ARGS = [
  "--add-header", "Accept-Language:en-US,en;q=0.9",
  "--add-header", "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "--no-check-certificates",
  "--force-ipv4",
  "--socket-timeout", "30",
];

const GENERIC_TX_ARGS = [
  "--socket-timeout", "30",
];

function isYouTube(url) {
  return /youtu\.?be|youtube\.com/i.test(url);
}

function isFacebook(url) {
  return /facebook\.com|fb\.watch/i.test(url);
}

function isInstagram(url) {
  return /instagram\.com/i.test(url);
}

function isTikTok(url) {
  return /tiktok\.com/i.test(url);
}

function getCookieArgs(url) {
  if (isInstagram(url) && fs.existsSync(INSTAGRAM_COOKIES_PATH))
    return ["--cookies", INSTAGRAM_COOKIES_PATH];
  if (isTikTok(url) && fs.existsSync(TIKTOK_COOKIES_PATH))
    return ["--cookies", TIKTOK_COOKIES_PATH];
  return [];
}

function getTxArgs(url) {
  if (isYouTube(url)) return YOUTUBE_TX_ARGS;
  if (isFacebook(url)) return FACEBOOK_TX_ARGS;
  return GENERIC_TX_ARGS;
}

function getArgs(url) {
  if (isYouTube(url)) return YOUTUBE_ARGS;
  if (isFacebook(url)) return FACEBOOK_TX_ARGS;
  return [];
}

const VISIT_OFFSET = 677;
const DOWNLOAD_OFFSET = 540;

// --- Routes ---

app.get("/api/stats", async (req, res) => {
  if (!pool) return res.json({ visits: VISIT_OFFSET, downloads: DOWNLOAD_OFFSET });
  try {
    const [visits, downloads] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM page_visits"),
      pool.query("SELECT COUNT(*) as count FROM video_downloads WHERE success = true"),
    ]);
    res.json({
      visits: parseInt(visits.rows[0].count) + VISIT_OFFSET,
      downloads: parseInt(downloads.rows[0].count) + DOWNLOAD_OFFSET,
    });
  } catch (e) {
    res.json({ visits: VISIT_OFFSET, downloads: DOWNLOAD_OFFSET });
  }
});

app.post("/api/visit", async (req, res) => {
  if (pool) {
    pool.query("INSERT INTO page_visits (created_at) VALUES (NOW())").catch(() => {});
  }
  res.json({ ok: true });
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/api/info", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL mancante" });
  try {
    const extra = [...getArgs(url), ...getCookieArgs(url)];
    const raw = await runYtDlp(["--dump-json", "--no-playlist", ...extra, url]);
    const data = JSON.parse(raw);
    const hasSubs = data.subtitles && Object.keys(data.subtitles).length > 0;
    const hasAuto = data.automatic_captions && Object.keys(data.automatic_captions).length > 0;
    res.json({
      title: data.title,
      thumbnail: data.thumbnail,
      duration: data.duration,
      uploader: data.uploader || data.channel || "",
      extractor: data.extractor_key || data.extractor || "",
      hasSubtitles: hasSubs || hasAuto,
      subtitleType: hasSubs ? "manual" : hasAuto ? "auto" : null,
      subLangs: (hasSubs ? Object.keys(data.subtitles) : hasAuto ? Object.keys(data.automatic_captions) : []).slice(0, 6),
    });
  } catch (e) {
    res.status(500).json({ error: friendlyError(e.message) });
  }
});

app.get("/api/download", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL mancante" });

  const rawTitle = (req.query.title || "video").toString().trim();
  const safeTitle = rawTitle.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80);
  const filename = `${safeTitle}.mp4`;
  const platform = detectPlatform(url);

  const extra = [...getArgs(url), ...getCookieArgs(url)];
  const bin = fs.existsSync(YTDLP_BIN) ? YTDLP_BIN : "yt-dlp";

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader("Content-Type", "video/mp4");

  const proc = spawn(bin, [
    "-f", "best[ext=mp4]/best",
    "--no-playlist",
    ...extra,
    "-o", "-",
    url,
  ]);

  let stderr = "";
  let bytesSent = 0;

  proc.stderr.on("data", (d) => (stderr += d.toString()));

  proc.stdout.on("data", (chunk) => {
    bytesSent += chunk.length;
  });

  proc.stdout.pipe(res);

  proc.on("close", (code) => {
    if (code === 0) {
      logDownload(url, platform, rawTitle, true);
    } else {
      const errorLine = stderr.split("\n").filter((l) => l.includes("ERROR")).pop() || stderr.slice(-400);
      const errMsg = friendlyError(errorLine.replace(/^.*ERROR:\s*/, ""));
      logDownload(url, platform, rawTitle, false, errMsg);
      if (!res.headersSent) {
        res.status(500).json({ error: errMsg });
      }
    }
  });

  req.on("close", () => proc.kill());
});

app.get("/api/subtitles", async (req, res) => {
  const url = req.query.url;
  const lang = req.query.lang || "it";
  if (!url) return res.status(400).json({ error: "URL mancante" });
  const tmpDir = os.tmpdir();
  const uid = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const outputTemplate = path.join(tmpDir, `sub_${uid}.%(ext)s`);
  try {
    const extra = [...getArgs(url), ...getCookieArgs(url)];
    await runYtDlp([
      "--write-subs", "--write-auto-subs",
      "--sub-langs", lang,
      "--sub-format", "vtt/srt/best",
      "--convert-subs", "vtt",
      "--skip-download", "--no-playlist",
      ...extra,
      "-o", outputTemplate,
      url,
    ]);
    const subFiles = fs.readdirSync(tmpDir).filter(
      (f) => f.startsWith(`sub_${uid}`) && (f.endsWith(".vtt") || f.endsWith(".srt"))
    );
    if (subFiles.length === 0)
      return res.status(404).json({ error: "Nessun sottotitolo disponibile per questo video" });
    const preferred = subFiles.find((f) => f.includes(`.${lang}.`) || f.includes(`-${lang}.`)) || subFiles[0];
    const rawContent = fs.readFileSync(path.join(tmpDir, preferred), "utf-8");
    const plainText = cleanSubtitles(rawContent);
    subFiles.forEach((f) => fs.unlink(path.join(tmpDir, f), () => {}));
    res.setHeader("Content-Disposition", `attachment; filename="sottotitoli_${lang}.txt"`);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(plainText);
  } catch (e) {
    try {
      fs.readdirSync(tmpDir).filter((f) => f.startsWith(`sub_${uid}`)).forEach((f) => fs.unlink(path.join(tmpDir, f), () => {}));
    } catch {}
    if (!res.headersSent) res.status(500).json({ error: friendlyError(e.message) });
  }
});

// --- Stream video (lettore) ---

app.get("/api/stream", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL mancante" });

  const extra = [...getArgs(url), ...getCookieArgs(url)];
  const bin = fs.existsSync(YTDLP_BIN) ? YTDLP_BIN : "yt-dlp";

  res.setHeader("Content-Type", "video/mp4");

  const proc = spawn(bin, [
    "-f", "best[ext=mp4]/best",
    "--no-playlist",
    ...extra,
    "-o", "-",
    url,
  ]);

  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.stdout.pipe(res);
  proc.on("close", (code) => {
    if (code !== 0 && !res.headersSent) {
      res.status(500).end();
    }
  });
  req.on("close", () => proc.kill());
});

// --- Trascrizione da URL ---

app.post("/api/transcribe-url", async (req, res) => {
  const { url, lang = "it" } = req.body;
  if (!url) return res.status(400).json({ error: "URL mancante" });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: "Groq API key non configurata sul server" });

  const uid = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const tmpDir = os.tmpdir();
  const outputTemplate = path.join(tmpDir, `txaudio_${uid}.%(ext)s`);

  try {
    const extra = [...getTxArgs(url), ...getCookieArgs(url)];
    await runYtDlp([
      "-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[ext=mp4]/best",
      "--no-playlist",
      "--no-post-overwrites",
      ...extra,
      "-o", outputTemplate,
      url,
    ]);

    const audioFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`txaudio_${uid}`));
    if (audioFiles.length === 0) throw new Error("Audio non trovato dopo il download");

    const audioPath = path.join(tmpDir, audioFiles[0]);
    const ext = audioFiles[0].split(".").pop() || "webm";
    const fileSize = fs.statSync(audioPath).size;

    if (fileSize > 24 * 1024 * 1024) {
      fs.unlinkSync(audioPath);
      return res.status(400).json({ error: "Audio troppo grande (max ~25MB). Prova con un video più corto (indicativamente meno di 40 minuti)." });
    }

    const fileBuffer = fs.readFileSync(audioPath);
    const mimeMap = { webm: "audio/webm", mp4: "audio/mp4", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav" };
    const mimeType = mimeMap[ext] || "audio/webm";

    const formData = new FormData();
    formData.append("file", new Blob([fileBuffer], { type: mimeType }), "audio." + ext);
    formData.append("model", "whisper-large-v3");
    formData.append("language", lang);
    formData.append("response_format", "text");

    const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: formData,
    });

    fs.unlinkSync(audioPath);

    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Errore Groq ${groqRes.status}`);
    }

    const text = await groqRes.text();
    if (!text || !text.trim()) throw new Error("Nessuna trascrizione ottenuta");

    res.json({ text: text.trim() });

  } catch (e) {
    try {
      fs.readdirSync(tmpDir).filter((f) => f.startsWith(`txaudio_${uid}`)).forEach((f) => {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
      });
    } catch {}
    res.status(500).json({ error: friendlyError(e.message) });
  }
});

// --- Trascrizione da file caricato ---

const uploadTx = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

app.post("/api/transcribe-file", uploadTx.single("file"), async (req, res) => {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: "Groq API key non configurata sul server" });
  if (!req.file) return res.status(400).json({ error: "Nessun file ricevuto" });

  const tmpPath = req.file.path;
  try {
    const ext = (req.file.originalname || "").split(".").pop().toLowerCase() || "mp3";
    const mimeMap = {
      mp3: "audio/mpeg", mp4: "audio/mp4", m4a: "audio/mp4",
      wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg",
      webm: "audio/webm", flac: "audio/flac", aac: "audio/aac",
      mov: "video/quicktime", avi: "video/x-msvideo",
    };
    const mimeType = mimeMap[ext] || req.file.mimetype || "audio/mpeg";
    const lang = req.body.lang || "it";

    const fileBuffer = fs.readFileSync(tmpPath);
    const formData = new FormData();
    formData.append("file", new Blob([fileBuffer], { type: mimeType }), "audio." + ext);
    formData.append("model", "whisper-large-v3");
    formData.append("language", lang);
    formData.append("response_format", "text");

    const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: formData,
    });

    if (!groqRes.ok) {
      const err = await groqRes.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Errore Groq ${groqRes.status}`);
    }

    const text = await groqRes.text();
    if (!text || !text.trim()) throw new Error("Nessuna trascrizione ottenuta");
    res.json({ text: text.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
});

// --- Admin ---

app.get("/api/admin/stats", async (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).json({ error: "Non autorizzato" });
  if (!pool) return res.status(503).json({ error: "Database non configurato" });
  try {
    const [totals, platforms, recent, daily, visits] = await Promise.all([
      pool.query("SELECT COUNT(*) as total, SUM(CASE WHEN success THEN 1 ELSE 0 END) as successes, SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) as failures FROM video_downloads"),
      pool.query("SELECT platform, COUNT(*) as count FROM video_downloads GROUP BY platform ORDER BY count DESC"),
      pool.query("SELECT url, title, platform, success, error, created_at FROM video_downloads ORDER BY created_at DESC LIMIT 500"),
      pool.query("SELECT DATE(created_at) as day, COUNT(*) as count FROM video_downloads WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY day ORDER BY day DESC"),
      pool.query("SELECT COUNT(*) as total, SUM(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END) as today, SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as week FROM page_visits"),
    ]);
    res.json({
      totals: totals.rows[0],
      platforms: platforms.rows,
      recent: recent.rows,
      daily: daily.rows,
      visits: visits.rows[0],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Merge video ---

const multer = require("multer");
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024, files: 10 } });

function cleanup(files) {
  for (const f of files) { try { fs.unlinkSync(f); } catch {} }
}

app.post("/api/merge", upload.array("files", 10), async (req, res) => {
  let items;
  try { items = JSON.parse(req.body.items || "[]"); } catch { return res.status(400).json({ error: "Formato items non valido" }); }
  const uploadedFiles = req.files || [];
  const tempFiles = uploadedFiles.map(f => f.path);
  const bin = fs.existsSync(YTDLP_BIN) ? YTDLP_BIN : "yt-dlp";

  if (items.length < 2) {
    cleanup(tempFiles);
    return res.status(400).json({ error: "Servono almeno 2 clip" });
  }

  try {
    const inputPaths = [];

    for (const item of items) {
      if (item.type === "url") {
        const uid = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        const outPath = path.join(os.tmpdir(), `merge_dl_${uid}.mp4`);
        tempFiles.push(outPath);
        const extra = [...getArgs(item.val), ...getCookieArgs(item.val)];
        await new Promise((resolve, reject) => {
          const proc = spawn(bin, ["-f", "best[ext=mp4]/best", "--no-playlist", ...extra, "-o", outPath, item.val]);
          let stderr = "";
          proc.stderr.on("data", d => stderr += d.toString());
          proc.on("close", code => {
            if (code === 0) resolve();
            else {
              const errLine = stderr.split("\n").filter(l => l.includes("ERROR")).pop() || stderr.slice(-200);
              reject(new Error(friendlyError(errLine.replace(/^.*ERROR:\s*/, ""))));
            }
          });
        });
        inputPaths.push(outPath);
      } else {
        const f = uploadedFiles[item.idx];
        if (!f) throw new Error("File caricato non trovato");
        inputPaths.push(f.path);
      }
    }

    const uid = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const concatFile = path.join(os.tmpdir(), `concat_${uid}.txt`);
    const outputFile = path.join(os.tmpdir(), `merged_${uid}.mp4`);
    tempFiles.push(concatFile, outputFile);

    fs.writeFileSync(concatFile, inputPaths.map(p => `file '${p}'`).join("\n"));

    const runFfmpeg = (args) => new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", args);
      let stderr = "";
      proc.stderr.on("data", d => stderr += d.toString());
      proc.on("close", code => code === 0 ? resolve() : reject(new Error(stderr.slice(-300))));
    });

    try {
      await runFfmpeg(["-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", "-y", outputFile]);
    } catch {
      await runFfmpeg(["-f", "concat", "-safe", "0", "-i", concatFile, "-c:v", "libx264", "-crf", "23", "-preset", "fast", "-c:a", "aac", "-b:a", "128k", "-y", outputFile]);
    }

    res.setHeader("Content-Disposition", `attachment; filename="video_unito.mp4"`);
    res.setHeader("Content-Type", "video/mp4");
    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    stream.on("close", () => cleanup(tempFiles));

  } catch (e) {
    cleanup(tempFiles);
    if (!res.headersSent) res.status(500).json({ error: e.message || "Errore durante l'unione" });
  }
});

app.listen(PORT, () => console.log(`Server avviato su porta ${PORT}`));
