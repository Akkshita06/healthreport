require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const Groq = require('groq-sdk');

console.log('========================================');
console.log('  BLOOD EXTRACTOR — BUILD 2026-06-16-C');
console.log('========================================');

// Default API key, loaded from the .env file. We check that it actually
// looks like a real Groq key (gsk_ + a long alphanumeric string) rather than
// comparing against the literal placeholder text — that way, nothing breaks
// if someone pastes their real key in an unexpected spot, and a leftover
// placeholder (which contains underscores/words) is correctly rejected.
const DEFAULT_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const HAS_DEFAULT_KEY = /^gsk_[A-Za-z0-9]{20,}$/.test(DEFAULT_API_KEY);

if (HAS_DEFAULT_KEY) {
  const masked = DEFAULT_API_KEY.slice(0, 4) + '…' + DEFAULT_API_KEY.slice(-4);
  console.log(`🔑 Default key loaded from .env — ${DEFAULT_API_KEY.length} chars, looks like ${masked}`);
} else {
  console.log('⚠  No default key configured in .env (still a placeholder, or empty)');
}

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.json({ limit: '10mb' }));

// ── Pure-JS PDF text extraction (no native deps) ─────────────────────────────
async function extractPdfText(buffer) {
  // pdfjs-dist v5's "legacy" Node build only ships as ESM (pdf.mjs), so it
  // must be loaded with a dynamic import() even from this CommonJS file.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const uint8 = new Uint8Array(buffer);
  const pdf = await pdfjsLib.getDocument({ data: uint8, verbosity: 0 }).promise;
  const numPages = Math.min(pdf.numPages, 20);
  let text = '';
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Reconstruct lines from text items preserving layout
    const items = content.items;
    let lastY = null;
    for (const item of items) {
      const y = item.transform ? item.transform[5] : 0;
      if (lastY !== null && Math.abs(y - lastY) > 5) text += '\n';
      text += item.str + ' ';
      lastY = y;
    }
    text += '\n\n';
  }
  return text.trim();
}

// ── Convert PDF pages to JPEG using pdf-to-img (pure wasm, no native) ────────
async function pdfToImages(buffer) {
  // pdf-to-img v6+ ships as ESM-only, so it must be loaded with a dynamic
  // import() even from this CommonJS file — require() throws
  // "require() cannot be used on an ESM graph with top-level await".
  const { pdf } = await import('pdf-to-img');
  const images = [];
  const doc = await pdf(buffer, { scale: 2 });
  let pageNum = 0;
  for await (const pageBuffer of doc) {
    images.push(pageBuffer.toString('base64'));
    pageNum++;
    if (pageNum >= 8) break;
  }
  return images;
}

const systemPrompt = `You are a medical data extraction specialist. Extract every blood test value from the report and return ONLY valid JSON — no markdown, no backticks, no explanation.

Required JSON structure:
{
  "patient": {
    "name": "string or null",
    "age": "string or null",
    "gender": "string or null",
    "report_date": "string or null",
    "lab_name": "string or null",
    "report_id": "string or null"
  },
  "summary": "2-3 sentence plain-English summary noting any abnormal values",
  "markers": [
    {
      "name": "Full test name",
      "short_name": "Abbreviation or null",
      "value": 0.0,
      "unit": "unit string or null",
      "reference_min": 0.0,
      "reference_max": 0.0,
      "reference_text": "raw reference range text from report",
      "status": "normal|high|low|critical_high|critical_low",
      "category": "CBC|Lipid Panel|Liver Function|Kidney Function|Thyroid|Diabetes|Vitamins|Electrolytes|Other"
    }
  ]
}

Rules:
- Extract EVERY measurable value — do not skip any test
- For non-numeric values (Positive/Negative/Reactive) set value to null
- Determine status by comparing value to reference range
- Return ONLY the JSON object`;

function parseAIResponse(rawText) {
  const clean = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(clean); } catch(_) {}
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error('No valid JSON in AI response');
}

app.get('/config-status', (req, res) => {
  res.json({ hasDefaultKey: HAS_DEFAULT_KEY });
});

app.post('/extract', upload.single('file'), async (req, res) => {
  const file = req.file;
  try {
    const overrideKey = (req.headers['x-api-key'] && req.headers['x-api-key'].trim()) || '';
    const apiKey = overrideKey || DEFAULT_API_KEY;
    if (overrideKey) {
      console.log(`🔓 Using OVERRIDE key from browser — ${overrideKey.length} chars, looks like ${overrideKey.slice(0,4)}…${overrideKey.slice(-4)}`);
    } else {
      console.log('🔑 Using DEFAULT key from .env');
    }
    if (!apiKey) return res.status(400).json({ error: 'No Groq API key configured. Add one to the .env file, or enter one in the browser as an override.' });
    if (!file)   return res.status(400).json({ error: 'No file uploaded' });

    const groq = new Groq({ apiKey });
    const fileBuffer = file.buffer;
    const mimeType = (file.mimetype || '').toLowerCase();
    const isPDF = mimeType === 'application/pdf' || file.originalname?.toLowerCase().endsWith('.pdf');

    let messages;

    if (isPDF) {
      console.log('📄 PDF detected:', file.originalname);

      // Strategy 1: text extraction (works for digital PDFs — fast, no vision needed)
      let text = '';
      try {
        text = await extractPdfText(fileBuffer);
        console.log(`   Text chars: ${text.length}`);
      } catch(e) {
        console.log('   Text extraction error:', e.message);
      }

      if (text.length > 300) {
        console.log('   → Text strategy');
        messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Extract all blood test values from this lab report:\n\n${text.slice(0, 16000)}` }
        ];
      } else {
        // Strategy 2: render pages to PNG (for scanned/image PDFs)
        console.log('   → Image rendering strategy (scanned PDF)');
        let images = [];
        try {
          images = await pdfToImages(fileBuffer);
          console.log(`   Rendered ${images.length} pages`);
        } catch(e) {
          console.log('   Image render error:', e.message);
          throw new Error('PDF could not be read as text or images. Is it password-protected?');
        }

        if (!images.length) throw new Error('PDF has no renderable pages.');

        const imgContent = images.map(b64 => ({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${b64}` }
        }));
        imgContent.push({ type: 'text', text: 'Extract all blood test values and return JSON as specified.' });
        messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: imgContent }
        ];
      }
    } else {
      // Direct image
      console.log('🖼  Image:', file.originalname, mimeType);
      const safeMime = ['image/png','image/jpeg','image/webp'].includes(mimeType) ? mimeType : 'image/jpeg';
      const base64Data = fileBuffer.toString('base64');
      messages = [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${safeMime};base64,${base64Data}` } },
            { type: 'text', text: 'Extract all blood test values and return JSON as specified.' }
          ]
        }
      ];
    }

    console.log('   Calling Groq...');
    const completion = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 4096,
      messages
    });

    const rawText = completion.choices[0]?.message?.content || '';
    const parsed = parseAIResponse(rawText);
    if (!Array.isArray(parsed.markers)) parsed.markers = [];

    
    console.log(`✅ ${parsed.markers.length} markers extracted`);
    res.json({ success: true, data: parsed });

  } catch(err) {
    console.error('❌', err.message);
 
    res.status(500).json({ error: err.message });
  }
});

app.post('/download-zip', async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'No data' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="blood_report_${new Date().toISOString().slice(0,10)}.zip"`);

  const archive = archiver('zip');
  archive.pipe(res);

  archive.append(JSON.stringify(data, null, 2), { name: 'blood_report.json' });

  const esc = v => `"${(v == null ? '' : String(v)).replace(/"/g, '""')}"`;
  const csvHeader = 'Test Name,Short Name,Category,Value,Unit,Reference Min,Reference Max,Reference Range,Status\n';
  const csvRows = (data.markers || []).map(m =>
    [m.name, m.short_name, m.category, m.value, m.unit,
     m.reference_min, m.reference_max, m.reference_text, m.status].map(esc).join(',')
  ).join('\n');
  archive.append(csvHeader + csvRows, { name: 'blood_markers.csv' });

  const p = data.patient || {};
  archive.append('Field,Value\n' + Object.entries(p).map(([k,v]) => `"${k}","${v||''}"`).join('\n'), { name: 'patient_info.csv' });

  archive.append(`Blood Report Extraction
=======================
Tool    : Blood Report Extractor (Groq / Llama 4 Scout)
Date    : ${new Date().toISOString()}

Summary : ${data.summary || 'N/A'}
Patient : ${p.name || 'Unknown'}
Lab     : ${p.lab_name || 'Unknown'}
Date    : ${p.report_date || 'Unknown'}
Markers : ${(data.markers||[]).length}
`, { name: 'readme.txt' });

  archive.finalize();
});

app.listen(3737, () => console.log('\n✅  http://localhost:3737\n'));
