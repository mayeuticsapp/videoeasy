const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const YTDLP_BIN = path.resolve(__dirname, "bin/yt-dlp");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// --- Helpers ---

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
    return "Troppe richieste a YouTube. Aspetta 30 secondi e riprova.";
  if (msg.toLowerCase().includes("private") || msg.toLowerCase().includes("sign in"))
    return "Video privato o che richiede accesso. Non scaricabile.";
  if (msg.toLowerCase().includes("no video formats"))
    return "Nessun formato video disponibile. Potrebbe richiedere login.";
  return msg;
}

// --- Routes ---

app.get("/api/info", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL mancante" });
  try {
    const raw = await runYtDlp(["--dump-json", "--no-playlist", url]);
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

app.get("/api/download", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "URL mancante" });
  const tmpDir = os.tmpdir();
  const uid = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const outputTemplate = path.join(tmpDir, `vdl_${uid}_%(title)s.%(ext)s`);
  let downloadedFile = null;
  try {
    await runYtDlp([
      "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--trim-filenames", "100",
      "-o", outputTemplate,
      url,
    ]);
    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`vdl_${uid}_`));
    if (files.length === 0) throw new Error("File non trovato dopo il download");
    downloadedFile = path.join(tmpDir, files[0]);
    const stat = fs.statSync(downloadedFile);
    const originalName = files[0].replace(`vdl_${uid}_`, "");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(originalName)}"`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    const stream = fs.createReadStream(downloadedFile);
    stream.pipe(res);
    res.on("finish", () => { if (downloadedFile) fs.unlink(downloadedFile, () => {}); });
    res.on("close", () => { if (downloadedFile) fs.unlink(downloadedFile, () => {}); });
  } catch (e) {
    if (downloadedFile) fs.unlink(downloadedFile, () => {});
    if (!res.headersSent) res.status(500).json({ error: friendlyError(e.message) });
  }
});

app.get("/api/subtitles", async (req, res) => {
  const url = req.query.url;
  const lang = req.query.lang || "it";
  if (!url) return res.status(400).json({ error: "URL mancante" });
  const tmpDir = os.tmpdir();
  const uid = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const outputTemplate = path.join(tmpDir, `sub_${uid}_%(title)s.%(ext)s`);
  try {
    await runYtDlp([
      "--write-subs", "--write-auto-subs",
      "--sub-langs", lang,
      "--sub-format", "vtt/srt/best",
      "--convert-subs", "vtt",
      "--skip-download", "--no-playlist",
      "--sleep-requests", "2",
      "-o", outputTemplate,
      url,
    ]);
    const subFiles = fs.readdirSync(tmpDir).filter(
      (f) => f.startsWith(`sub_${uid}_`) && (f.endsWith(".vtt") || f.endsWith(".srt"))
    );
    if (subFiles.length === 0)
      return res.status(404).json({ error: "Nessun sottotitolo disponibile per questo video" });
    const preferred = subFiles.find((f) => f.includes(`.${lang}.`) || f.includes(`-${lang}.`)) || subFiles[0];
    const rawContent = fs.readFileSync(path.join(tmpDir, preferred), "utf-8");
    const plainText = cleanSubtitles(rawContent);
    const titleMatch = preferred.replace(`sub_${uid}_`, "").replace(/\.[a-z-]+\.vtt$/, "").replace(/\.vtt$/, "");
    subFiles.forEach((f) => fs.unlink(path.join(tmpDir, f), () => {}));
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(titleMatch + "_sottotitoli.txt")}"`);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(plainText);
  } catch (e) {
    try {
      fs.readdirSync(tmpDir).filter((f) => f.startsWith(`sub_${uid}_`)).forEach((f) => fs.unlink(path.join(tmpDir, f), () => {}));
    } catch {}
    if (!res.headersSent) res.status(500).json({ error: friendlyError(e.message) });
  }
});

app.listen(PORT, () => console.log(`Server avviato su porta ${PORT}`));
