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
    )
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
  if (msg.toLowerCase().includes("private") || msg.toLowerCase().includes("sign in") || msg.toLowerCase().includes("bot"))
    return "YouTube ha bloccato il server. Riprova tra qualche minuto.";
  if (msg.toLowerCase().includes("no video formats"))
    return "Nessun formato video disponibile.";
  return msg;
}

const YOUTUBE_ARGS = [
  "--extractor-args", "youtube:player_client=ios,web",
  "--user-agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];

function isYouTube(url) {
  return /youtu\.?be|youtube\.com/i.test(url);
}

// --- Routes ---

app.get("/api/info", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL mancante" });
  try {
    const extra = isYouTube(url) ? YOUTUBE_ARGS : [];
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

  const extra = isYouTube(url) ? YOUTUBE_ARGS : [];
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
    const extra = isYouTube(url) ? YOUTUBE_ARGS : [];
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

// --- Admin ---

app.get("/api/admin/stats", async (req, res) => {
  if (req.query.key !== ADMIN_PASSWORD) return res.status(401).json({ error: "Non autorizzato" });
  if (!pool) return res.status(503).json({ error: "Database non configurato" });
  try {
    const [totals, platforms, recent, daily] = await Promise.all([
      pool.query("SELECT COUNT(*) as total, SUM(CASE WHEN success THEN 1 ELSE 0 END) as successes, SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) as failures FROM video_downloads"),
      pool.query("SELECT platform, COUNT(*) as count FROM video_downloads GROUP BY platform ORDER BY count DESC"),
      pool.query("SELECT title, platform, success, error, created_at FROM video_downloads ORDER BY created_at DESC LIMIT 20"),
      pool.query("SELECT DATE(created_at) as day, COUNT(*) as count FROM video_downloads WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY day ORDER BY day DESC"),
    ]);
    res.json({
      totals: totals.rows[0],
      platforms: platforms.rows,
      recent: recent.rows,
      daily: daily.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Server avviato su porta ${PORT}`));
