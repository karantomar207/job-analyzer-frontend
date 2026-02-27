/**
 * JobLens AI – Content Script
 * Injected into job pages. Detects job context, injects the overlay,
 * and bridges the page ↔ background worker communication.
 * NOTE: Self-contained – no ES module imports (content scripts don't support them).
 */

// ─── Inlined from utils/jobExtractor.js ──────────────────────────────────────
const SiteType = { LINKEDIN: "linkedin", INTERNSHALA: "internshala", GENERIC: "generic", UNSUPPORTED: "unsupported" };

function detectSite(url = window.location.href) {
  if (/linkedin\.com\/jobs/.test(url)) return SiteType.LINKEDIN;
  if (/internshala\.com\/(internship|jobs)/.test(url)) return SiteType.INTERNSHALA;
  if (hasJobKeywords()) return SiteType.GENERIC;
  return SiteType.UNSUPPORTED;
}

function hasJobKeywords() {
  const t = document.body?.innerText?.toLowerCase() || "";
  return ["responsibilities", "requirements", "qualifications", "job description", "what you will do", "skills required"].some(k => t.includes(k));
}

function extractJobData() {
  const site = detectSite();
  let data;
  if (site === SiteType.LINKEDIN) data = extractLinkedIn();
  else if (site === SiteType.INTERNSHALA) data = extractInternshala();
  else if (site === SiteType.GENERIC) data = extractGeneric();
  else return null;
  if (!data) return null;
  return ensureJobDescription({
    ...data,
    site,
    url: window.location.href,
    extractedAt: new Date().toISOString(),
  });
}

function getText(sel) { return document.querySelector(sel)?.innerText?.trim() || ""; }

function extractLinkedIn() {
  try {
    const title = getText(".job-details-jobs-unified-top-card__job-title") || getText(".jobs-unified-top-card__job-title") || getText("h1");
    const company =
      getText(".job-details-jobs-unified-top-card__company-name a") ||
      getText(".jobs-unified-top-card__company-name a") ||
      getText(".job-details-jobs-unified-top-card__company-name") ||
      getText(".jobs-unified-top-card__company-name") ||
      getText(".jobs-unified-top-card__subtitle-primary-grouping a") ||
      getText(".topcard__org-name-link");
    const location = getText(".job-details-jobs-unified-top-card__bullet") || getText(".jobs-unified-top-card__bullet");
    const descEl = document.querySelector(".jobs-description__content") || document.querySelector(".jobs-description") || document.querySelector("#job-details");
    const description = descEl?.innerText?.trim() || "";
    const experience = parseExperience(description);
    const salary = extractSalary(description);
    const skillEls = document.querySelectorAll(".job-details-skill-match-status-list__unmatched-skill-text, .job-details-preferences-and-skills__pill");
    const skills = [...skillEls].map(el => el.innerText.trim()).filter(Boolean);
    return { title, company, location, experience, salary, description, skills };
  } catch (e) { return extractGeneric(); }
}

function extractInternshala() {
  try {
    const title = getText(".profile h1") || getText("h1.job-internship-name") || getText("h1");
    const company = getText(".company-name") || getText(".link_display_like_text .heading_6");
    const location = getText(".location_link") || "";
    const descWrapper = document.querySelector("#about_internship") || document.querySelector(".internship-description");
    const description = descWrapper?.innerText?.trim() || document.body.innerText.trim().slice(0, 5000);
    const experience = parseExperience(description);
    const salary = extractSalary(getText(".stipend_container") || description);
    const skillEls = document.querySelectorAll(".round_tabs .round_without_icon, .tags_container .tag");
    const skills = [...skillEls].map(el => el.innerText.trim()).filter(Boolean);
    return { title, company, location, experience, salary, description, skills };
  } catch (e) { return extractGeneric(); }
}

function extractGeneric() {
  try {
    const title = document.querySelector("h1")?.innerText?.trim() || document.title;
    const company = document.querySelector('[class*="company"]')?.innerText?.trim() || "";
    const location = document.querySelector('[class*="location"]')?.innerText?.trim() || "";
    const descEl = document.querySelector('[class*="description"]') || document.querySelector("main") || document.body;
    const clone = descEl.cloneNode(true);
    ["nav", "header", "footer", "script", "style"].forEach(t => clone.querySelectorAll(t).forEach(n => n.remove()));
    const description = (clone.innerText || "").trim().slice(0, 8000);
    return { title, company, location, experience: parseExperience(description), salary: extractSalary(description), description, skills: [] };
  } catch (e) { return null; }
}

function parseExperience(text) {
  const m = text.match(/(\d+)\+?\s*(?:to|-)\s*(\d+)\s*years?/i) || text.match(/(\d+)\+?\s*years?\s+(?:of\s+)?(?:experience|exp)/i);
  return m ? (m[2] ? `${m[1]}-${m[2]} years` : `${m[1]}+ years`) : "Not specified";
}

function extractSalary(text) {
  const m = text.match(/(?:₹|rs\.?|inr)\s*[\d,]+[^\n]*/i) || text.match(/\$\s*[\d,]+[^\n]*/i) || text.match(/stipend[:\s]+[^\n]*/i);
  return m ? m[0].trim() : "Not disclosed";
}

function ensureJobDescription(jobData) {
  const current = (jobData?.description || "").replace(/\s+/g, " ").trim();
  if (current.length >= 50) return { ...jobData, description: current.slice(0, 8000) };

  const selectors = [
    ".jobs-description__content",
    ".jobs-description-content__text",
    ".jobs-description",
    "#job-details",
    "[class*='description']",
    "main",
    "[role='main']",
    "article",
    "body",
  ];

  let fallback = "";
  for (const sel of selectors) {
    const txt = document.querySelector(sel)?.innerText?.replace(/\s+/g, " ").trim() || "";
    if (txt.length > fallback.length) fallback = txt;
    if (fallback.length >= 1200) break;
  }

  const merged = [current, fallback].filter(Boolean).join("\n\n").trim();
  return { ...jobData, description: merged.slice(0, 8000) };
}


// ─── State ────────────────────────────────────────────────────────────────────
let overlayInjected = false;
let currentJobData = null;
let overlayPanel = null;
let lastOpenedUrl = null; // URL for which sidebar was last opened
let currentJobIdentity = "";
let lastExtractionSuccessAt = 0;

// ─── Init ─────────────────────────────────────────────────────────────────────
(function init() {
  // Hook into history.pushState/replaceState (LinkedIn SPA navigation)
  const _pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _pushState(...args);
    schedulePageCheck();
  };
  const _replaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    _replaceState(...args);
    schedulePageCheck();
  };
  window.addEventListener("popstate", schedulePageCheck);

  // MutationObserver fallback
  const observer = new MutationObserver(debounce(onPageChange, 800));
  observer.observe(document.body, { childList: true, subtree: true });

  // URL polling safety net
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      schedulePageCheck();
    }
  }, 1500);

  onPageChange();
})();

function schedulePageCheck() {
  setTimeout(onPageChange, 400);
  setTimeout(onPageChange, 1200);
  setTimeout(onPageChange, 3000);
}

// ─── URL-based job page detection (no DOM required) ───────────────────────────
function isJobPageUrl(url = location.href) {
  return (
    /linkedin\.com\/jobs\/view\//i.test(url) ||
    /linkedin\.com\/jobs\/search\/.*currentJobId/i.test(url) ||
    /internshala\.com\/(internship|jobs)\//i.test(url)
  );
}

function onPageChange() {
  const url = location.href;

  // ── Step 1: URL-based check — open sidebar without needing DOM ready ─────
  if (isJobPageUrl(url) && url !== lastOpenedUrl) {
    lastOpenedUrl = url;

    // Inject overlay if first time
    if (!overlayInjected) injectOverlay();

    // Auto-open sidebar
    if (overlayPanel && !overlayPanel.classList.contains("open")) {
      overlayPanel.classList.add("open");
    }
  }

  // ── Step 2: Try to extract job data and update sidebar when job changes ──
  const jobData = tryExtractJobData();
  if (!jobData) {
    // Avoid stale state when navigating away from job pages.
    if (!isJobPageUrl(url)) {
      currentJobData = null;
      currentJobIdentity = "";
      lastExtractionSuccessAt = 0;
      notifyPopup(null);
    } else {
      // On job URLs, clear stale data if extraction keeps failing for a while.
      const tooStale = lastExtractionSuccessAt && Date.now() - lastExtractionSuccessAt > 12000;
      if (tooStale) {
        currentJobData = null;
        currentJobIdentity = "";
        notifyPopup(null);
      }
    }
    return;
  }

  const normalizedJobData = ensureJobDescription(jobData);
  const nextIdentity = getJobIdentity(normalizedJobData);
  const isNewJob = currentJobIdentity !== nextIdentity;

  // Update stored job data
  currentJobData = normalizedJobData;
  currentJobIdentity = nextIdentity;
  lastExtractionSuccessAt = Date.now();
  notifyPopup(normalizedJobData);

  // Keep header synced even when only company/title appears late.
  if (overlayPanel) {
    updateSidebarJobHeader(normalizedJobData);
  }

  // When job switches: update title/company and prompt manual analyze.
  if (isNewJob && overlayPanel) {
    showReadyState();
  }
}

// Lenient extraction — returns null only on complete failure, never an empty title
function tryExtractJobData() {
  const url = location.href;

  // LinkedIn
  if (/linkedin\.com\/jobs/i.test(url)) {
    const title =
      getText(".job-details-jobs-unified-top-card__job-title h1") ||
      getText(".jobs-unified-top-card__job-title") ||
      getText(".job-details-jobs-unified-top-card__job-title") ||
      getText(".job-card-list__title") ||
      getText(".jobs-details-top-card__job-title") ||
      getText(".t-24.t-bold.inline") ||
      getText("h1.jobs-unified-top-card__job-title") ||
      getText(".artdeco-entity-lockup__title em") ||
      getText("h2[class*='job-title']") ||
      // Broad fallback: any h1/h2 inside the job details pane
      (document.querySelector(".jobs-details,.jobs-search__job-details,#job-details")?.querySelector("h1,h2")?.innerText?.trim()) ||
      document.title.replace(/ *[|\-–] .*$/, "").trim(); // strip site name from tab title

    if (!title) return null;

    const company =
      getText(".job-details-jobs-unified-top-card__company-name a") ||
      getText(".jobs-unified-top-card__company-name a") ||
      getText(".job-details-jobs-unified-top-card__company-name") ||
      getText(".jobs-unified-top-card__company-name") ||
      getText(".job-details-jobs-unified-top-card__primary-description-container a") ||
      getText(".jobs-unified-top-card__subtitle-primary-grouping a") ||
      getText(".job-details-jobs-unified-top-card__primary-description") ||
      getText(".topcard__org-name-link") ||
      getText(".job-card-container__company-name");

    const descEl =
      document.querySelector(".jobs-description__content") ||
      document.querySelector(".jobs-description") ||
      document.querySelector("#job-details") ||
      document.querySelector(".jobs-details__main-content");

    const description = descEl?.innerText?.trim() || "";

    return ensureJobDescription({
      title, company,
      location: getText(".job-details-jobs-unified-top-card__bullet") || getText(".jobs-unified-top-card__bullet"),
      description, skills: [],
      experience: parseExperience(description),
      salary: extractSalary(description),
      site: "linkedin", url, extractedAt: new Date().toISOString()
    });
  }

  // Internshala / generic fallback
  const generic = extractJobData();
  return generic?.title ? ensureJobDescription(generic) : null;
}

// Update job title/company in sidebar header without wiping results
function updateSidebarJobHeader(jobData) {
  if (!overlayPanel) return;
  const titleEl = overlayPanel.querySelector(".jl-job-title");
  let companyEl = overlayPanel.querySelector(".jl-job-company");
  const jobInfoEl = overlayPanel.querySelector(".jl-job-info");

  if (titleEl) titleEl.textContent = jobData.title || "Detected Job";

  const nextCompany = (jobData.company || "").trim();
  if (nextCompany) {
    if (!companyEl && jobInfoEl) {
      companyEl = document.createElement("div");
      companyEl.className = "jl-job-company";
      jobInfoEl.appendChild(companyEl);
    }
    if (companyEl) companyEl.textContent = nextCompany;
  } else if (companyEl) {
    companyEl.remove();
  }
}

// Show "ready to analyze" state in the sidebar content area
function showReadyState() {
  const content = overlayPanel?.querySelector("#jl-content");
  if (!content) return;
  const analyzeBtn = overlayPanel?.querySelector("#jl-analyze-btn");
  if (analyzeBtn) analyzeBtn.dataset.analyzed = "false";
  content.innerHTML = `
    <div class="jl-intro">
      <p>New job detected. Analyze this job to update your match report.</p>
      <button class="jl-btn primary" id="jl-analyze-btn">
        🔍 Analyze My Match
      </button>
    </div>
  `;
  // Re-wire the analyze button
  content.querySelector("#jl-analyze-btn")?.addEventListener("click", () => {
    showLoadingState();
    requestAnalysis();
  });
}

function getJobSignature(jobData) {
  const url = (jobData.url || "").trim().toLowerCase();
  const title = (jobData.title || "").trim().toLowerCase();
  const company = (jobData.company || "").trim().toLowerCase();
  return `${url}|${title}|${company}`;
}

function getJobIdentity(jobData) {
  const url = String(jobData?.url || location.href);

  // LinkedIn stable IDs
  const viewId = url.match(/linkedin\.com\/jobs\/view\/(\d+)/i)?.[1];
  if (viewId) return `li_view_${viewId}`;

  const currentJobId = url.match(/[?&]currentJobId=(\d+)/i)?.[1];
  if (currentJobId) return `li_search_${currentJobId}`;

  // Internshala / generic fallback
  return getJobSignature(jobData);
}


// ─── Message Listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "GET_JOB_DATA":
      // Force a fresh extraction at request time to avoid stale cached state.
      try {
        const live = tryExtractJobData();
        if (live?.title) {
          const normalized = ensureJobDescription(live);
          currentJobData = normalized;
          currentJobIdentity = getJobIdentity(normalized);
          lastExtractionSuccessAt = Date.now();
          notifyPopup(normalized);
          sendResponse({ success: true, data: normalized });
        } else {
          sendResponse({ success: true, data: currentJobData });
        }
      } catch (_) {
        sendResponse({ success: true, data: currentJobData });
      }
      break;

    case "SHOW_RESULT":
      if (!overlayInjected) injectOverlay();
      overlayPanel && overlayPanel.classList.add("open");
      showResultInOverlay(msg.data);
      sendResponse({ success: true });
      break;

    // Sent by ANALYZE_AND_SHOW before analysis starts — open sidebar in loading state
    case "OPEN_OVERLAY_LOADING":
      if (!overlayInjected) injectOverlay();
      overlayPanel && overlayPanel.classList.add("open");
      showLoadingState();
      sendResponse({ success: true });
      break;

    // Sent by ANALYZE_AND_SHOW when analysis fails (popup already closed)
    case "SHOW_ERROR":
      if (!overlayInjected) injectOverlay();
      overlayPanel && overlayPanel.classList.add("open");
      showErrorState(msg.error || "Analysis failed. Please try again.");
      sendResponse({ success: true });
      break;

    case "TOGGLE_OVERLAY":
      toggleOverlay();
      sendResponse({ success: true });
      break;

    case "CLOSE_OVERLAY":
      closeOverlay();
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ success: false });
  }
  return true;
});

// ─── Overlay Injection ────────────────────────────────────────────────────────
function injectOverlay() {
  if (overlayInjected && overlayPanel) return;

  // Shadow DOM to isolate styles from the host page
  const host = document.createElement("div");
  host.id = "joblens-host";
  host.style.cssText = "position:fixed;top:0;right:0;z-index:2147483647;pointer-events:none;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  // Inject styles into shadow DOM
  const style = document.createElement("style");
  style.textContent = getOverlayStyles();
  shadow.appendChild(style);

  // Build the toggle button
  const toggleBtn = document.createElement("button");
  toggleBtn.id = "jl-toggle";
  toggleBtn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" stroke="white" stroke-width="2"/>
      <path d="M8 12h8M12 8l4 4-4 4" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span>JobLens</span>
  `;
  toggleBtn.style.pointerEvents = "auto";
  toggleBtn.addEventListener("click", toggleOverlay);
  shadow.appendChild(toggleBtn);

  // Build the panel
  overlayPanel = document.createElement("div");
  overlayPanel.id = "jl-panel";
  overlayPanel.innerHTML = getInitialPanelHTML();
  overlayPanel.style.pointerEvents = "auto";
  shadow.appendChild(overlayPanel);

  // Wire up close button
  overlayPanel.querySelector("#jl-close-btn")?.addEventListener("click", closeOverlay);

  overlayInjected = true;
}

function toggleOverlay() {
  if (!overlayPanel) return;
  overlayPanel.classList.toggle("open");
  // NOTE: No auto-analysis here — the sidebar's "Analyze" button is the trigger.
}

function closeOverlay() {
  overlayPanel?.classList.remove("open");
}

function showLoadingState() {
  const content = overlayPanel?.querySelector("#jl-content");
  if (!content) return;
  content.innerHTML = `
    <div class="jl-loading">
      <div class="jl-spinner"></div>
      <p>Analyzing job requirements…</p>
      <span class="jl-sub">This takes about 5–10 seconds</span>
    </div>
  `;
}

function showErrorState(msg) {
  const content = overlayPanel?.querySelector("#jl-content");
  if (!content) return;
  content.innerHTML = `
    <div class="jl-error">
      <div class="jl-error-icon">⚠️</div>
      <p>${escHtml(msg)}</p>
      <button class="jl-btn" id="jl-retry">Retry</button>
    </div>
  `;
  content.querySelector("#jl-retry")?.addEventListener("click", () => {
    showLoadingState();
    requestAnalysis();
  });
}

async function requestAnalysis() {
  // Retrieve resume from storage
  const resume = await getStoredResume();
  if (!resume) {
    showErrorState("No resume found. Please upload your resume in the JobLens popup first.");
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "ANALYZE_JOB",
      payload: {
        jobData: currentJobData,
        resumeText: resume.raw,
        url: currentJobData.url,
      },
    },
    (response) => {
      if (chrome.runtime.lastError) {
        showErrorState("Extension error: " + chrome.runtime.lastError.message);
        return;
      }
      if (response?.success) {
        showResultInOverlay(response.data);
      } else {
        showErrorState(response?.error || "Analysis failed. Please try again.");
      }
    }
  );
}

// ─── Result Rendering ─────────────────────────────────────────────────────────
function showResultInOverlay(result) {
  const content = overlayPanel?.querySelector("#jl-content");
  if (!content) return;

  const pct = result.match_percentage || 0;
  const matchClass =
    pct >= 80 ? "strong" : pct >= 60 ? "moderate" : "weak";
  const matchLabel =
    pct >= 80 ? "Strong Match" : pct >= 60 ? "Moderate Match" : "Weak Match";
  const matchEmoji = pct >= 80 ? "🟢" : pct >= 60 ? "🟡" : "🔴";

  const fromCache = result.fromCache
    ? `<span class="jl-badge cache">Cached</span>`
    : `<span class="jl-badge fresh">Fresh Analysis</span>`;

  content.innerHTML = `
    <div class="jl-result">
      ${fromCache}

      <!-- Match Circle -->
      <div class="jl-match-circle ${matchClass}">
        <svg viewBox="0 0 120 120" class="jl-donut">
          <circle class="jl-donut-bg" cx="60" cy="60" r="50" />
          <circle class="jl-donut-ring" cx="60" cy="60" r="50"
            stroke-dasharray="${pct * 3.14} ${314 - pct * 3.14}"
            stroke-dashoffset="78.5" />
        </svg>
        <div class="jl-match-inner">
          <span class="jl-match-pct">${pct}%</span>
          <span class="jl-match-label">${matchEmoji} ${matchLabel}</span>
        </div>
      </div>

      <!-- Experience Required -->
      ${result.experience_required ? `
        <div class="jl-card">
          <div class="jl-card-title">⏱ Experience Required</div>
          <p>${escHtml(result.experience_required)}</p>
        </div>` : ""}

      <!-- Matched Skills -->
      ${renderTagSection("✅ Matched Skills", result.matched_skills, "match-tag")}

      <!-- Missing Skills -->
      ${renderTagSection("❌ Missing Skills", result.missing_skills, "miss-tag")}

      <!-- Hidden Requirements -->
      ${renderListSection("🔍 Hidden Requirements", result.hidden_requirements)}

      <!-- ATS Keywords Missing -->
      ${renderTagSection("🤖 ATS Keywords Missing", result.ats_keywords_missing, "ats-tag")}

      <!-- Resume Improvements -->
      ${renderListSection("📝 Resume Improvement Tips", result.resume_improvement_suggestions)}

      <!-- Recommended Projects -->
      ${renderListSection("🚀 Recommended Projects to Build", result.recommended_projects)}

      <!-- Confidence Score -->
      <div class="jl-confidence">
        AI Confidence: <strong>${result.confidence_score || "N/A"}%</strong>
      </div>
    </div>
  `;

  const analyzeBtn = overlayPanel?.querySelector("#jl-analyze-btn");
  if (analyzeBtn) analyzeBtn.dataset.analyzed = "true";
}

function renderTagSection(title, items, tagClass) {
  if (!items?.length) return "";
  const tags = items
    .map((s) => `<span class="jl-tag ${tagClass}">${escHtml(s)}</span>`)
    .join("");
  return `
    <div class="jl-card">
      <div class="jl-card-title">${title}</div>
      <div class="jl-tags">${tags}</div>
    </div>`;
}

function renderListSection(title, items) {
  if (!items?.length) return "";
  const lis = items
    .map((s) => `<li>${escHtml(s)}</li>`)
    .join("");
  return `
    <div class="jl-card">
      <div class="jl-card-title">${title}</div>
      <ul class="jl-list">${lis}</ul>
    </div>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getStoredResume() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["resume"], (data) => resolve(data.resume || null));
  });
}

function notifyPopup(jobData) {
  const type = jobData ? "UPSERT_CURRENT_JOB" : "CLEAR_CURRENT_JOB";
  const payload = jobData ? { jobData } : {};
  chrome.runtime.sendMessage({ type, payload }, () => {
    if (chrome.runtime.lastError) {
      // Ignore transient send errors (e.g. service worker spin-up timing).
      return;
    }
  });
}

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Initial Panel HTML ───────────────────────────────────────────────────────
function getInitialPanelHTML() {
  const jobTitle = currentJobData?.title || "Detected Job";
  const company = currentJobData?.company || "";

  return `
    <div class="jl-panel-header">
      <div class="jl-logo">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="11" fill="url(#jl-grad)" />
          <path d="M7 12l3 3 7-7" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <defs>
            <linearGradient id="jl-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
              <stop stop-color="#6366f1"/>
              <stop offset="1" stop-color="#8b5cf6"/>
            </linearGradient>
          </defs>
        </svg>
        <span>JobLens AI</span>
      </div>
      <button id="jl-close-btn" class="jl-close" aria-label="Close">×</button>
    </div>

    <div class="jl-job-info">
      <div class="jl-job-title">${escHtml(jobTitle)}</div>
      ${company ? `<div class="jl-job-company">${escHtml(company)}</div>` : ""}
    </div>

    <div id="jl-content">
      <div class="jl-intro">
        <p>Resume loaded and ready for analysis.</p>
        <button class="jl-btn primary" id="jl-analyze-btn">
          🔍 Analyze My Match
        </button>
      </div>
    </div>
  `;
}

// ─── Overlay Styles (injected into Shadow DOM) ────────────────────────────────
function getOverlayStyles() {
  return `
    :host { all: initial; }

    #jl-toggle {
      position: fixed;
      top: 50%;
      right: 0;
      transform: translateY(-50%);
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: white;
      border: none;
      border-radius: 12px 0 0 12px;
      padding: 14px 10px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      font-family: 'Inter', -apple-system, sans-serif;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
      box-shadow: -4px 0 20px rgba(99,102,241,0.4);
      transition: all 0.2s ease;
      pointer-events: auto;
      z-index: 1;
      writing-mode: vertical-rl;
    }
    #jl-toggle:hover {
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      box-shadow: -6px 0 24px rgba(99,102,241,0.5);
    }

    #jl-panel {
      position: fixed;
      top: 0;
      right: -420px;
      width: 400px;
      height: 100vh;
      background: #0f0f1a;
      border-left: 1px solid rgba(99,102,241,0.2);
      box-shadow: -10px 0 40px rgba(0,0,0,0.5);
      font-family: 'Inter', -apple-system, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      overflow-y: auto;
      transition: right 0.35s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 2;
      scrollbar-width: thin;
      scrollbar-color: rgba(99,102,241,0.3) transparent;
    }
    #jl-panel.open { right: 0; }

    .jl-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 20px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .jl-logo {
      display: flex;
      align-items: center;
      gap: 10px;
      color: white;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.3px;
    }

    .jl-close {
      background: rgba(255,255,255,0.2);
      border: none;
      color: white;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
    }
    .jl-close:hover { background: rgba(255,255,255,0.35); }

    .jl-job-info {
      padding: 16px 20px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .jl-job-title {
      font-size: 15px;
      font-weight: 600;
      color: #e2e8f0;
      margin-bottom: 4px;
    }
    .jl-job-company {
      font-size: 13px;
      color: #94a3b8;
    }

    #jl-content {
      padding: 20px;
      color: #cbd5e1;
    }

    .jl-intro {
      text-align: center;
      padding: 30px 0;
    }
    .jl-intro p {
      color: #94a3b8;
      margin-bottom: 20px;
      font-size: 14px;
    }

    .jl-btn {
      padding: 10px 22px;
      border-radius: 10px;
      border: none;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: all 0.2s;
      font-family: inherit;
    }
    .jl-btn.primary {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: white;
      box-shadow: 0 4px 15px rgba(99,102,241,0.3);
      width: 100%;
      padding: 14px;
    }
    .jl-btn.primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(99,102,241,0.4);
    }

    /* Loading */
    .jl-loading {
      text-align: center;
      padding: 50px 20px;
      color: #94a3b8;
    }
    .jl-spinner {
      width: 44px;
      height: 44px;
      border: 3px solid rgba(99,102,241,0.2);
      border-top-color: #6366f1;
      border-radius: 50%;
      animation: jl-spin 0.8s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes jl-spin { to { transform: rotate(360deg); } }
    .jl-loading p { font-size: 15px; font-weight: 500; color: #cbd5e1; margin-bottom: 6px; }
    .jl-sub { font-size: 12px; color: #64748b; }

    /* Error */
    .jl-error {
      text-align: center;
      padding: 40px 10px;
      color: #f87171;
    }
    .jl-error-icon { font-size: 36px; margin-bottom: 12px; }
    .jl-error p { margin-bottom: 20px; font-size: 14px; }

    /* Match Circle */
    .jl-match-circle {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      margin: 20px auto;
      width: 160px;
      height: 160px;
    }
    .jl-donut {
      width: 160px;
      height: 160px;
      transform: rotate(-90deg);
    }
    .jl-donut-bg {
      fill: none;
      stroke: rgba(255,255,255,0.05);
      stroke-width: 12;
    }
    .jl-donut-ring {
      fill: none;
      stroke-width: 12;
      stroke-linecap: round;
      transition: stroke-dasharray 1s ease;
    }
    .strong .jl-donut-ring { stroke: #22c55e; }
    .moderate .jl-donut-ring { stroke: #f59e0b; }
    .weak .jl-donut-ring { stroke: #ef4444; }

    .jl-match-inner {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
    }
    .jl-match-pct {
      display: block;
      font-size: 32px;
      font-weight: 800;
      color: #e2e8f0;
      line-height: 1;
    }
    .jl-match-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      margin-top: 4px;
      white-space: nowrap;
    }

    /* Cards */
    .jl-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 12px;
    }
    .jl-card-title {
      font-size: 13px;
      font-weight: 700;
      color: #a5b4fc;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .jl-card p {
      font-size: 14px;
      color: #cbd5e1;
      margin: 0;
    }

    /* Tags */
    .jl-tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .jl-tag {
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
    }
    .match-tag { background: rgba(34,197,94,0.15); color: #86efac; border: 1px solid rgba(34,197,94,0.3); }
    .miss-tag { background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid rgba(239,68,68,0.3); }
    .ats-tag { background: rgba(245,158,11,0.15); color: #fcd34d; border: 1px solid rgba(245,158,11,0.3); }

    /* Lists */
    .jl-list {
      margin: 0;
      padding-left: 18px;
      font-size: 13px;
      color: #cbd5e1;
      line-height: 1.7;
    }
    .jl-list li { margin-bottom: 4px; }

    /* Badges */
    .jl-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 16px;
    }
    .jl-badge.cache { background: rgba(99,102,241,0.15); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.3); }
    .jl-badge.fresh { background: rgba(34,197,94,0.15); color: #86efac; border: 1px solid rgba(34,197,94,0.3); }

    /* Confidence */
    .jl-confidence {
      text-align: center;
      font-size: 12px;
      color: #64748b;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .jl-confidence strong { color: #94a3b8; }
  `;
}
