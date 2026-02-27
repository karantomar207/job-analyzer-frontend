/**
 * JobLens AI – Popup Script
 * Handles all 4 tabs: Analyze, Resume, History, Settings
 */

import { parseResume } from "./utils/resumeParser.js";
import {
    analyzeJob,
    getRateLimitStatus,
    saveResume,
    loadResume,
    deleteResume,
    getSettings,
    saveSettings,
    clearCache,
    saveAnalysisToHistory,
    getAnalysisHistory,
    verifyBackendUrl,
} from "./utils/apiClient.js";

// ─── State ────────────────────────────────────────────────────────────────────
let currentJobData = null;
let currentResume = null;

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
    setupTabs();
    setupResumeTab();
    setupSettingsTab();
    setupHistoryTab();

    await Promise.all([
        loadCurrentJob(),
        loadResumeStatus(),
        loadRateLimit(),
    ]);

    setupAnalyzeButton();
    subscribeJobUpdates();
    window.addEventListener("focus", refreshFromActiveTab);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshFromActiveTab();
    });
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function setupTabs() {
    document.querySelectorAll(".tab").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
            btn.classList.add("active");
            $(`tab-${btn.dataset.tab}-content`)?.classList.add("active");

            if (btn.dataset.tab === "history") renderHistory();
        });
    });
}

// ─── Current Job Detection ────────────────────────────────────────────────────
async function loadCurrentJob() {
    const activeTabJob = await getActiveTabJobData();
    if (activeTabJob?.title) {
        renderCurrentJob(activeTabJob);
        return;
    }

    // Fallback for cases where content script isn't reachable yet.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        renderCurrentJob(null);
        return;
    }

    const tabJob = await getCurrentJobForTab(tab.id);
    renderCurrentJob(tabJob || null);
}

function renderCurrentJob(currentJob) {
    const skeleton = $("job-skeleton");
    const content = $("job-content");
    const none = $("job-none");

    skeleton?.classList.add("hidden");

    if (currentJob && currentJob.title) {
        currentJobData = currentJob;
        content?.classList.remove("hidden");
        none?.classList.add("hidden");

        $("job-title").textContent = currentJob.title || "Unknown Title";
        $("job-meta").textContent = [currentJob.company, currentJob.location]
            .filter(Boolean).join(" · ");
        $("job-exp").textContent = currentJob.experience !== "Not specified"
            ? `Experience: ${currentJob.experience}` : "";
        $("job-site-badge").textContent = capitalize(currentJob.site || "Job");
        refreshAnalyzeBtn();
    } else {
        currentJobData = null;
        content?.classList.add("hidden");
        none?.classList.remove("hidden");
        refreshAnalyzeBtn();
    }
}

function subscribeJobUpdates() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        if (!changes.currentJobByTab && !changes.currentJob) return;
        refreshFromActiveTab();
    });
}

async function refreshFromActiveTab() {
    const activeTabJob = await getActiveTabJobData();
    if (activeTabJob?.title) {
        renderCurrentJob(activeTabJob);
        return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        renderCurrentJob(null);
        return;
    }

    const tabJob = await getCurrentJobForTab(tab.id);
    renderCurrentJob(tabJob || null);
}

async function getActiveTabJobData() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return null;

        return await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { type: "GET_JOB_DATA" }, (resp) => {
                if (chrome.runtime.lastError) {
                    resolve(null);
                    return;
                }
                resolve(resp?.success ? resp.data : null);
            });
        });
    } catch (_) {
        return null;
    }
}

async function getCurrentJobForTab(tabId) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(
            { type: "GET_CURRENT_JOB_FOR_TAB", payload: { tabId } },
            (resp) => {
                if (chrome.runtime.lastError) {
                    resolve(null);
                    return;
                }
                resolve(resp?.success ? resp.data : null);
            }
        );
    });
}

// ─── Resume Status ────────────────────────────────────────────────────────────
async function loadResumeStatus() {
    currentResume = await loadResume();
    const icon = $("rs-icon");
    const text = $("rs-text");
    const link = $("rs-upload-link");

    if (currentResume) {
        icon.textContent = "✅";
        text.textContent = "Resume loaded";
        link.textContent = "Update";
    } else {
        icon.textContent = "📄";
        text.textContent = "No resume uploaded";
        link.textContent = "Upload now";
    }

    link?.addEventListener("click", () => {
        document.querySelector('[data-tab="resume"]')?.click();
    });

    refreshAnalyzeBtn();
}

// ─── Rate Limit ───────────────────────────────────────────────────────────────
async function loadRateLimit() {
    const rl = await getRateLimitStatus();
    const count = $("rl-count");
    const pills = $("rl-pills");

    if (count) count.textContent = `${rl.remaining}/${rl.total}`;

    if (pills) {
        pills.innerHTML = "";
        for (let i = 0; i < rl.total; i++) {
            const pill = document.createElement("div");
            pill.className = `rl-pill ${i < rl.remaining ? "filled" : "empty"}`;
            pills.appendChild(pill);
        }
    }
}

// ─── Analyze Button ───────────────────────────────────────────────────────────
function refreshAnalyzeBtn() {
    const btn = $("analyze-btn");
    if (!btn) return;
    btn.disabled = !(currentJobData && currentResume);
}

function setupAnalyzeButton() {
    $("analyze-btn")?.addEventListener("click", runAnalysis);
}

async function runAnalysis() {
    if (!currentJobData) {
        showToast("Open a supported job page first.", "error");
        return;
    }
    if (!currentResume?.raw?.trim()) {
        showToast("Resume is required. Please upload/paste your resume first.", "error");
        return;
    }

    const btn = $("analyze-btn");
    const btnText = $("analyze-btn-text");
    const spinner = $("btn-spinner");

    // Brief feedback before closing popup
    btn.disabled = true;
    btnText.textContent = "Opening sidebar…";
    spinner?.classList.remove("hidden");

    try {
        // Get the active tab so background can push result to it
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
            throw new Error("Could not detect active tab for analysis.");
        }

        const freshJobData = await getFreshJobDataFromTab(tab.id);
        if (freshJobData?.title) {
            currentJobData = freshJobData;
        }

        const settings = await getSettings();
        const verified = await verifyBackendUrl(settings.backendUrl || "");
        if (!verified?.success) {
            throw new Error(verified?.error || "Backend URL is invalid or unreachable. Verify it in Settings.");
        }

        const descriptionLength = (currentJobData?.description || "").trim().length;
        if (descriptionLength < 50) {
            throw new Error("Job description is still loading on this page. Scroll the job details once, wait 2-3 seconds, then try again.");
        }

        const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                type: "ANALYZE_AND_SHOW",
                payload: {
                    jobData: currentJobData,
                    resumeText: currentResume.raw,
                    url: currentJobData.url,
                    tabId: tab.id,
                },
            }, (resp) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve(resp);
            });
        });

        if (!response?.success) {
            throw new Error(response?.error || "Failed to start analysis.");
        }

        // Close popup — sidebar will show loading state then result
        setTimeout(() => window.close(), 200);

    } catch (err) {
        // Fallback: show error in popup if something went wrong before sending
        btn.disabled = false;
        btnText.textContent = "🔍 Analyze My Match";
        spinner?.classList.add("hidden");
        showToast("Error: " + err.message, "error");
    }
}

async function getFreshJobDataFromTab(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: "GET_JOB_DATA" }, (resp) => {
            if (chrome.runtime.lastError) {
                resolve(null);
                return;
            }
            resolve(resp?.success ? resp.data : null);
        });
    });
}


function renderResultPreview(result, container) {
    const pct = result.match_percentage || 0;
    const matchClass = pct >= 80 ? "strong" : pct >= 60 ? "moderate" : "weak";
    const emoji = pct >= 80 ? "🟢" : pct >= 60 ? "🟡" : "🔴";
    const label = pct >= 80 ? "Strong Match" : pct >= 60 ? "Moderate Match" : "Weak Match";

    container.innerHTML = `
    <div class="result-preview">
      <div class="rp-match ${matchClass}">
        <span class="rp-pct">${pct}%</span>
        <span class="rp-label">${emoji} ${label}</span>
      </div>
      ${result.missing_skills?.length ? `
        <div class="rp-section">
          <div class="rp-section-title">Top Missing Skills</div>
          <div class="rp-tags">
            ${result.missing_skills.slice(0, 6).map(s => `<span class="rp-tag miss">${escHtml(s)}</span>`).join("")}
          </div>
        </div>` : ""}
      ${result.matched_skills?.length ? `
        <div class="rp-section">
          <div class="rp-section-title">Matched (${result.matched_skills.length})</div>
          <div class="rp-tags">
            ${result.matched_skills.slice(0, 4).map(s => `<span class="rp-tag match">${escHtml(s)}</span>`).join("")}
          </div>
        </div>` : ""}
      <p class="rp-hint">👉 Open the side panel for full details & suggestions</p>
    </div>
  `;
}

function renderError(msg, container, isRateLimit = false) {
    container.innerHTML = `
    <div class="popup-error">
      <div class="pe-icon">${isRateLimit ? "⏳" : "⚠️"}</div>
      <p>${escHtml(msg)}</p>
    </div>
  `;
}

// ─── Resume Tab ───────────────────────────────────────────────────────────────
function setupResumeTab() {
    const saveBtn = $("save-resume-btn");
    const deleteBtn = $("delete-resume-btn");
    const textarea = $("resume-textarea");

    // Pre-fill if resume exists
    loadResume().then((r) => {
        if (r) {
            textarea.value = r.raw || "";
            showSavedResumeInfo(r);
        }
    });

    // "Open Resume Manager" button → opens options.html in a new tab
    $("open-manager-btn")?.addEventListener("click", () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
    });

    saveBtn?.addEventListener("click", async () => {
        const text = textarea.value.trim();
        if (!text) { showToast("Please enter resume text.", "error"); return; }
        await handleResumeText(text);
    });

    deleteBtn?.addEventListener("click", async () => {
        await deleteResume();
        currentResume = null;
        textarea.value = "";
        $("resume-saved-info")?.classList.add("hidden");
        loadResumeStatus();
        showToast("Resume deleted.", "info");
    });
}

async function handleResumeFile(file) {
    if (file.size > 2 * 1024 * 1024) {
        showParseError("File too large. Max 2MB.");
        return;
    }
    showParseProgress(true);
    try {
        const { raw, parsed } = await parseResume(file);
        $("resume-textarea").value = raw;
        await saveResume(raw, parsed);
        currentResume = { raw, parsed };
        showSavedResumeInfo({ raw, parsed, savedAt: new Date().toISOString() });
        loadResumeStatus();
        showToast("Resume saved successfully! ✅", "success");
    } catch (err) {
        showParseError(err.message);
    } finally {
        showParseProgress(false);
    }
}

async function handleResumeText(text) {
    showParseProgress(true);
    try {
        const { raw, parsed } = await parseResume(text);
        await saveResume(raw, parsed);
        currentResume = { raw, parsed };
        showSavedResumeInfo({ raw, parsed, savedAt: new Date().toISOString() });
        loadResumeStatus();
        showToast("Resume saved! ✅", "success");
    } catch (err) {
        showParseError(err.message);
    } finally {
        showParseProgress(false);
    }
}

function showSavedResumeInfo(resume) {
    const info = $("resume-saved-info");
    const skillsEl = $("rsi-skills");
    const dateEl = $("rsi-date");
    info?.classList.remove("hidden");

    const skills = resume.parsed?.skills?.slice(0, 8) || [];
    skillsEl.textContent = skills.length
        ? `Skills detected: ${skills.join(", ")}${resume.parsed?.skills?.length > 8 ? ` +${resume.parsed.skills.length - 8} more` : ""}`
        : "Skills: none detected automatically";

    dateEl.textContent = `Saved: ${new Date(resume.savedAt).toLocaleString()}`;
}

function showParseProgress(show) {
    const el = $("parse-progress");
    show ? el?.classList.remove("hidden") : el?.classList.add("hidden");
    $("parse-error")?.classList.add("hidden");
}

function showParseError(msg) {
    const el = $("parse-error");
    if (el) { el.textContent = "❌ " + msg; el.classList.remove("hidden"); }
}

// ─── Upload Zone Drag & Drop ─────────────────────────────────────────────────
function setupUploadZone() {
    const zone = $("upload-zone");
    if (!zone) return;

    zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", async (e) => {
        e.preventDefault();
        zone.classList.remove("dragover");
        const file = e.dataTransfer?.files?.[0];
        if (file) {
            document.querySelector('[data-tab="resume"]')?.click();
            await handleResumeFile(file);
        }
    });
}

// ─── History Tab ─────────────────────────────────────────────────────────────
function setupHistoryTab() {
    $("clear-history-btn")?.addEventListener("click", async () => {
        await chrome.storage.local.remove(["history"]);
        renderHistory();
        showToast("History cleared.", "info");
    });
}

async function renderHistory() {
    const list = $("history-list");
    if (!list) return;

    const history = await getAnalysisHistory();

    if (!history.length) {
        list.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">📋</div>
        <p>No analyses yet. Start by opening a job page!</p>
      </div>`;
        return;
    }

    list.innerHTML = history.map((entry) => {
        const pct = entry.matchPercentage || 0;
        const cls = pct >= 80 ? "strong" : pct >= 60 ? "moderate" : "weak";
        return `
      <div class="history-item">
        <div class="hi-main">
          <div class="hi-title">${escHtml(entry.jobTitle || "Unknown")}</div>
          <div class="hi-company">${escHtml(entry.company || "")}</div>
          <div class="hi-date">${new Date(entry.analyzedAt).toLocaleDateString()}</div>
        </div>
        <div class="hi-pct ${cls}">${pct}%</div>
      </div>`;
    }).join("");
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────
async function setupSettingsTab() {
    const settings = await getSettings();

    const urlInput = $("backend-url");
    const overlayToggle = $("overlay-toggle");

    if (urlInput) urlInput.value = settings.backendUrl || "http://localhost:8000";
    if (overlayToggle) overlayToggle.checked = settings.overlayEnabled !== false;

    $("save-settings-btn")?.addEventListener("click", async () => {
        const nextUrl = (urlInput?.value || "").trim();
        if (!isValidHttpUrl(nextUrl)) {
            showToast("Enter a valid backend URL (http/https).", "error");
            return;
        }

        await saveSettings({
            backendUrl: nextUrl,
            overlayEnabled: overlayToggle?.checked !== false,
        });
        showToast("Settings saved! ✅", "success");
    });

    $("verify-backend-btn")?.addEventListener("click", async () => {
        const testUrl = (urlInput?.value || "").trim();
        if (!isValidHttpUrl(testUrl)) {
            showToast("Enter a valid backend URL first.", "error");
            return;
        }

        showToast("Checking backend...", "info");
        const result = await verifyBackendUrl(testUrl);
        if (result?.success) {
            showToast(`Backend OK (${result.service || "service"}) ✅`, "success");
            await saveSettings({
                backendUrl: result.backendUrl || testUrl,
                overlayEnabled: overlayToggle?.checked !== false,
            });
        } else {
            showToast(result?.error || "Backend verification failed.", "error");
        }
    });

    $("clear-cache-btn")?.addEventListener("click", async () => {
        const result = await clearCache();
        showToast(`Cleared ${result.cleared} cached result(s).`, "info");
    });
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = "info") {
    const toast = $("toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `toast toast-${type}`;
    setTimeout(() => toast.classList.add("hidden"), 3000);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function escHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function isValidHttpUrl(value) {
    const v = String(value || "").trim();
    if (!v) return false;
    try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch (_) {
        return false;
    }
}
