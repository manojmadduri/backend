// backend/server.js
require('dotenv').config();

const express    = require('express');
const multer     = require('multer');
const cors       = require('cors');
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

const app = express();

// ─── 1) CORS ────────────────────────────────────────────────────────────────────
// Allow all origins for now (or lock down to your Vercel domain)
app.use(cors());
app.options('*', cors()); // preflight

// ─── 2) Health Endpoint ─────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ─── 3) Ensure upload directory exists ─────────────────────────────────────────
const uploadDir = process.env.UPLOAD_DIR || 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ─── 4) Multer config ──────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename:   (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// ─── 5) POST /api/upload ───────────────────────────────────────────────────────
app.post('/api/upload', upload.array('files'), (req, res) => {
  const dataPath     = path.join(uploadDir, 'data.txt');
  const smartPath    = path.join(uploadDir, 'memories.jsonl');
  const finetunePath = path.join(uploadDir, 'finetune_data.jsonl');

  // Combine uploaded files
  const out = fs.createWriteStream(dataPath);
  req.files.forEach(f => out.write(fs.readFileSync(f.path, 'utf-8') + '\n\n'));
  out.end();

  const pythonCmd = process.env.PYTHON_PATH || 'python3';

  // 5a) generate_jsonl_smart.py
  let genErr = '';
  const gen = spawn(
    pythonCmd,
    ['scripts/generate_jsonl_smart.py', '--input', dataPath, '--output', smartPath],
    { cwd: __dirname }
  );
  gen.stderr.on('data', chunk => genErr += chunk.toString());

  gen.on('close', code => {
    if (code !== 0) {
      console.error('generate_jsonl_smart error:', genErr);
      return res.status(500).send(`Error generating smart JSONL:\n${genErr}`);
    }

    // 5b) prepare_finetune_dataset.py
    let prepErr = '';
    const prep = spawn(
      pythonCmd,
      ['scripts/prepare_finetune_dataset.py', '--input', smartPath, '--output', finetunePath],
      { cwd: __dirname }
    );
    prep.stderr.on('data', chunk => prepErr += chunk.toString());

    prep.on('close', code2 => {
      if (code2 !== 0) {
        console.error('prepare_finetune_dataset error:', prepErr);
        return res.status(500).send(`Error preparing fine-tune JSONL:\n${prepErr}`);
      }

      // 5c) Success
      res.json({
        smart:    `/api/download/${path.basename(smartPath)}`,
        finetune: `/api/download/${path.basename(finetunePath)}`
      });
    });
  });
});

// ─── 6) GET /api/download/:filename ─────────────────────────────────────────────
app.get('/api/download/:filename', (req, res) => {
  const file = path.join(uploadDir, req.params.filename);
  if (fs.existsSync(file)) {
    res.download(file);
  } else {
    res.status(404).send(`File not found: ${req.params.filename}`);
  }
});

// ─── 7) Start the server ────────────────────────────────────────────────────────
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Backend listening on port ${port}`));
