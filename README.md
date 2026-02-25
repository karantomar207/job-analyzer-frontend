# JobLens AI – Smart Job Page Analyzer
### "Know your chances before you apply."

A production-ready **Chrome Extension** powered by **Groq AI** that automatically analyzes job pages, matches them against your resume, detects hidden requirements, and gives you actionable insights — all in seconds.

---

## 📂 Project Structure

```
job-analyzer/
├── manifest.json           # Chrome MV3 manifest
├── background.js           # Service worker: routing, caching, rate limiting
├── content.js              # Job detection + Shadow DOM overlay panel
├── popup.html              # Extension popup (4-tab UI)
├── popup.js                # Popup logic
├── popup.css               # Popup styles
├── styles.css              # Page-level stylesheet (minimal)
├── icons/                  # Extension icons (16/32/48/128px)
└── utils/
    ├── jobExtractor.js     # LinkedIn/Internshala/generic DOM parser
    ├── resumeParser.js     # Client-side PDF/DOCX/text parser
    └── apiClient.js        # Background worker comms + storage helpers

backend/
├── main.py                 # FastAPI app entry point
├── config.py               # Pydantic settings (reads .env)
├── requirements.txt        # Python dependencies
├── .env.example            # Environment variable template
├── routes/
│   └── analyze.py          # POST /analyze endpoint
└── services/
    └── groqService.py      # Groq LLM integration + prompt engineering
```

---

## 🚀 Quick Start

### 1. Backend Setup

```bash
cd backend

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env and add your GROQ_API_KEY from https://console.groq.com
nano .env

# Start the server
python main.py
# Server runs at http://localhost:8000
```

### 2. Load the Extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer Mode** (top right)
3. Click **"Load unpacked"**
4. Select the `job-analyzer/` folder (this folder)
5. The JobLens AI icon appears in your toolbar ✅

### 3. First Use

1. Click the **JobLens AI** icon in your toolbar
2. Go to **Resume tab** → Upload your PDF/DOCX or paste resume text → **Save**
3. Navigate to a LinkedIn or Internshala job page
4. The floating **JobLens** button appears on the right side of the page
5. Click **"Analyze My Match"** in the popup or click the side panel button
6. Get your full AI analysis in ~5-10 seconds 🎉

---

## 🔑 Getting a Groq API Key

1. Go to [console.groq.com](https://console.groq.com)
2. Sign up / Log in
3. Navigate to **API Keys** → **Create API Key**
4. Copy the key and paste it in `backend/.env`

---

## 🧠 How It Works

```
Job Page (LinkedIn/Internshala)
    ↓ DOM Parsing (content.js)
    ↓ jobExtractor.js extracts: title, company, description, skills
    ↓
Popup / Overlay triggers analysis
    ↓ resume loaded from chrome.storage.local
    ↓
background.js (service worker)
    ↓ checks rate limit (10/day)
    ↓ checks URL cache (24h TTL)
    ↓
POST /analyze → FastAPI Backend
    ↓ groqService.py builds rich prompt
    ↓ Groq LLM (llama-3.3-70b-versatile)
    ↓ JSON response parsed + validated
    ↓
Result → cached → sent back to extension
    ↓
Overlay panel shows:
  • Match % (circular progress)
  • Matched / Missing skills
  • Hidden requirements
  • ATS keywords gap
  • Resume improvement tips
  • Recommended projects
```

---

## 📊 Features

| Feature | Status |
|---------|--------|
| LinkedIn job extraction | ✅ |
| Internshala job extraction | ✅ |
| Generic career page extraction | ✅ |
| PDF resume parsing (client-side) | ✅ |
| DOCX resume parsing (client-side) | ✅ |
| Groq AI analysis | ✅ |
| Match percentage + circle UI | ✅ |
| Hidden requirements detection | ✅ |
| ATS keyword gap analysis | ✅ |
| Resume improvement suggestions | ✅ |
| Project recommendations | ✅ |
| URL-based result caching (24h) | ✅ |
| Rate limiting (10/day) | ✅ |
| Analysis history | ✅ |
| Shadow DOM overlay (no style leak) | ✅ |
| Resume stored locally only | ✅ |
| Backend API key proxy | ✅ |

---

## 🔒 Security & Privacy

- **Resume never leaves your device** (stored in `chrome.storage.local`)
- **Groq API key stored server-side only** – never exposed to browser
- Shadow DOM overlay prevents CSS conflicts with host page
- Rate limiting prevents abuse (10 analyses/day)
- No analytics or tracking

---

## 🛠 Development

### Backend API Docs
After starting the server, visit: `http://localhost:8000/docs`

### Changing the AI Model
Edit `backend/services/groqService.py`:
```python
model: str = "llama-3.3-70b-versatile"  # change to any Groq model
```

Available Groq models: `llama-3.1-8b-instant` (faster), `llama-3.3-70b-versatile` (recommended), `mixtral-8x7b-32768`

---

## 🚧 Future Roadmap

- [ ] Apply with AI-optimized resume
- [ ] Generate custom cover letter
- [ ] Track applied jobs dashboard
- [ ] Job alerts / saved searches
- [ ] Subscription system
- [ ] Deploy backend to Railway/Render

---

## 📄 License
MIT
