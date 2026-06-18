# Blood Report Extractor

Extracts blood test values from any PDF or image using Groq AI.
Zero native/system dependencies — works on Windows, Mac, Linux out of the box.

## Requirements
- Node.js 20.19+ or 22.13+ (LTS recommended) — https://nodejs.org
- Groq API key (free) — https://console.groq.com/keys

## Setup

1. Open the `.env` file in this folder and replace the placeholder with your real Groq API key:
   ```
   GROQ_API_KEY=gsk_your_real_key_here
   ```
2. Install and run:
   ```
   npm install
   npm start
   ```

Open → http://localhost:3737

Once `.env` is set, the web page will use that key automatically — you never need to type it in again. You can still override it for a single request via the "use a different key for this request" link on the page.

## What it handles

| PDF Type              | Method                          |
|-----------------------|---------------------------------|
| Digital / clinic PDF  | Text extraction (fast, accurate)|
| Scanned / image PDF   | Page rendering via WebAssembly  |
| PNG / JPG / WEBP      | Direct vision upload to Groq    |

## Output ZIP
- blood_report.json  — full structured data
- blood_markers.csv  — all values in table format
- patient_info.csv   — patient details
- readme.txt         — summary
