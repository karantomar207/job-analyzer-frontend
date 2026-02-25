/**
 * JobLens AI – Resume Manager (options.js)
 * External script for options.html (inline scripts blocked by Chrome MV3 CSP).
 */

const $ = id => document.getElementById(id);

// ── Load existing resume on open ──────────────────────────────────────────────
chrome.storage.local.get(['resume'], ({ resume }) => {
    if (resume) {
        $('resume-textarea').value = resume.raw || '';
        showStatus(resume);
    }
});

// ── Browse Button ─────────────────────────────────────────────────────────────
$('browse-btn').addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    $('file-input').click();
});

// ── File selected ─────────────────────────────────────────────────────────────
$('file-input').addEventListener('change', async function (e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { showError('File too large. Max 2MB.'); return; }
    await processFile(file);
    this.value = '';
});

// ── Drag and Drop ─────────────────────────────────────────────────────────────
const zone = $('upload-zone');
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
zone.addEventListener('drop', async e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) await processFile(file);
});

// ── Process file ──────────────────────────────────────────────────────────────
async function processFile(file) {
    showProgress(true);
    try {
        const raw = await readFile(file);
        if (!raw || raw.trim().length < 30) {
            throw new Error('Could not extract text. Please paste your resume text instead.');
        }
        const parsed = extractFields(raw);
        $('resume-textarea').value = raw;
        await store(raw, parsed);
        showToast('Resume saved! ✅', 'success');
    } catch (err) {
        showError(err.message || 'Failed to read file.');
    } finally {
        showProgress(false);
    }
}

// ── File Reading ──────────────────────────────────────────────────────────────
async function readFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'txt') return file.text();
    if (ext === 'pdf') return readPdf(file);
    if (ext === 'docx' || ext === 'doc') return readDocx(file);
    throw new Error('Unsupported file type. Use PDF, DOCX, or TXT.');
}

async function readPdf(file) {
    if (!window.pdfjsLib) throw new Error('PDF library not loaded. Please paste your resume text.');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map(x => x.str).join(' '));
    }
    return pages.join('\n\n');
}

async function readDocx(file) {
    if (!window.mammoth) throw new Error('DOCX library not loaded. Please paste your resume text.');
    const buf = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return result.value;
}

// ── Save (paste text) ─────────────────────────────────────────────────────────
$('save-btn').addEventListener('click', async () => {
    const text = $('resume-textarea').value.trim();
    if (!text) { showError('Please paste some text first.'); return; }
    if (text.length < 30) { showError('Text too short to be a resume.'); return; }
    showProgress(true);
    try {
        const parsed = extractFields(text);
        await store(text, parsed);
        showToast('Resume saved! ✅', 'success');
    } catch (err) {
        showError(err.message);
    } finally {
        showProgress(false);
    }
});

// ── Delete ────────────────────────────────────────────────────────────────────
$('delete-btn').addEventListener('click', async () => {
    await chrome.storage.local.remove(['resume']);
    $('resume-textarea').value = '';
    $('status-card').classList.remove('visible');
    showToast('Resume removed.', 'error');
});

// ── Storage ───────────────────────────────────────────────────────────────────
async function store(raw, parsed) {
    const entry = { raw, parsed, savedAt: new Date().toISOString() };
    await chrome.storage.local.set({ resume: entry });
    showStatus(entry);
}

// ── Field Extractor ───────────────────────────────────────────────────────────
function extractFields(text) {
    const skills = new Set();
    const techRe = /\b(python|javascript|typescript|java|react|vue|angular|node\.?js|django|flask|fastapi|mysql|postgresql|mongodb|redis|docker|kubernetes|aws|gcp|azure|git|html|css|sql|c\+\+|golang|rust|php|swift|kotlin|tensorflow|pytorch|figma|linux)\b/gi;
    let m;
    while ((m = techRe.exec(text)) !== null) skills.add(m[0].toLowerCase());
    const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    const expMatch = text.match(/(\d+)\+?\s*years?\s+(?:of\s+)?(?:experience|exp)/i);
    return {
        skills: [...skills].slice(0, 40),
        email: emailMatch ? emailMatch[0] : '',
        experienceYears: expMatch ? parseInt(expMatch[1]) : 0,
        education: [], projects: [], certifications: []
    };
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function showStatus(resume) {
    const skills = (resume.parsed && resume.parsed.skills) ? resume.parsed.skills.slice(0, 8) : [];
    const extra = (resume.parsed && resume.parsed.skills && resume.parsed.skills.length > 8)
        ? ` +${resume.parsed.skills.length - 8} more` : '';
    $('sc-skills').textContent = skills.length
        ? `Skills: ${skills.join(', ')}${extra}`
        : 'No skills auto-detected (resume still saved).';
    $('sc-date').textContent = `Saved: ${new Date(resume.savedAt).toLocaleString()}`;
    $('status-card').classList.add('visible');
}

function showProgress(show) {
    $('progress-bar').classList.toggle('visible', show);
    $('error-msg').classList.remove('visible');
    $('save-btn').disabled = show;
}

function showError(msg) {
    const el = $('error-msg');
    el.textContent = '❌ ' + msg;
    el.classList.add('visible');
}

function showToast(msg, type) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast ' + type + ' show';
    setTimeout(() => t.classList.remove('show'), 3000);
}
