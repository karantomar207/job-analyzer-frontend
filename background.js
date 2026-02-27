/**
 * JobLens AI – Background Service Worker
 * Handles: message routing, rate limiting, result caching, tab management
 */

// ─── Constants ───────────────────────────────────────────────────────────────
const DAILY_LIMIT = 10;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "ANALYZE_JOB":
      handleAnalyzeJob(message.payload).then(sendResponse).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // keep channel open for async

    // Fire-and-forget: closes popup immediately, pushes result to sidebar
    case "ANALYZE_AND_SHOW": {
      if (!message.payload?.jobData || !message.payload?.resumeText) {
        sendResponse({ success: false, error: "Missing job or resume payload." });
        return false;
      }
      const tabId = message.payload.tabId;
      handleAnalyzeAndShow(message.payload, tabId);
      sendResponse({ success: true, queued: true });
      return false;
    }

    case "GET_RATE_LIMIT_STATUS":
      getRateLimitStatus().then(sendResponse);
      return true;

    case "UPSERT_CURRENT_JOB":
      upsertCurrentJobForTab(sender.tab?.id, message.payload?.jobData).then(sendResponse);
      return true;

    case "CLEAR_CURRENT_JOB":
      clearCurrentJobForTab(sender.tab?.id).then(sendResponse);
      return true;

    case "GET_CURRENT_JOB_FOR_TAB":
      getCurrentJobForTab(message.payload?.tabId).then(sendResponse);
      return true;

    case "VERIFY_BACKEND_URL":
      verifyBackendUrl(message.payload?.url).then(sendResponse);
      return true;

    case "CLEAR_CACHE":
      clearCache().then(sendResponse);
      return true;

    case "GET_CACHED_RESULT":
      getCachedResult(message.payload.url).then(sendResponse);
      return true;

    default:
      sendResponse({ success: false, error: "Unknown message type" });
  }
});

// ─── Analyze + Push to Sidebar (fire-and-forget from popup) ──────────────────
async function handleAnalyzeAndShow({ jobData, resumeText, url }, tabId) {
  // Open sidebar immediately so user sees loading state while analysis runs
  if (tabId) {
    safeSendToTab(tabId, { type: "OPEN_OVERLAY_LOADING" });
  }

  try {
    const response = await handleAnalyzeJob({ jobData, resumeText, url });

    if (tabId) {
      if (response.success) {
        safeSendToTab(tabId, { type: "SHOW_RESULT", data: { ...response.data, fromCache: response.fromCache } });
      } else {
        safeSendToTab(tabId, { type: "SHOW_ERROR", error: response.error, rateLimited: response.rateLimited });
      }
    }
  } catch (err) {
    if (tabId) {
      safeSendToTab(tabId, { type: "SHOW_ERROR", error: err.message });
    }
  }
}

// ─── Job Analysis Handler ─────────────────────────────────────────────────────
async function handleAnalyzeJob({ jobData, resumeText, url }) {
  if (!resumeText || !resumeText.trim()) {
    throw new Error("Resume is required. Please upload or paste your resume first.");
  }

  if (!jobData || !jobData.title) {
    throw new Error("Job details are missing. Open a supported job page and try again.");
  }

  // 1. Check cache first
  const cached = await getCachedResult(url);
  if (cached) {
    return { success: true, data: cached, fromCache: true };
  }

  // 2. Check rate limit
  const limitOk = await checkAndDecrementRateLimit();
  if (!limitOk) {
    return {
      success: false,
      error: "Daily analysis limit reached (10/day). Resets at midnight.",
      rateLimited: true,
    };
  }

  // 3. Call backend proxy
  try {
    const settings = await getSettings();
    const backendUrl = normalizeBackendUrl(settings.backendUrl || "http://localhost:8000");

    const response = await fetch(`${backendUrl}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobData, resumeText }),
      signal: AbortSignal.timeout(60000), // 60s timeout
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(parseBackendError(response.status, errBody));
    }

    const result = await response.json();

    // 4. Cache the result
    await cacheResult(url, result);

    return { success: true, data: result, fromCache: false };
  } catch (err) {
    // Refund the rate limit token on failure
    await refundRateLimitToken();
    throw err;
  }
}

async function verifyBackendUrl(rawUrl) {
  let backendUrl = "";
  try {
    backendUrl = normalizeBackendUrl(rawUrl || "");
  } catch (err) {
    return { success: false, error: err.message || "Invalid backend URL." };
  }

  try {
    const response = await fetch(`${backendUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Health check failed with status ${response.status}.`,
      };
    }

    const data = await response.json().catch(() => ({}));
    return {
      success: true,
      backendUrl,
      service: data?.service || "unknown",
      status: data?.status || "ok",
    };
  } catch (err) {
    return {
      success: false,
      error: "Unable to reach backend. Check URL/server/CORS and try again.",
    };
  }
}

function parseBackendError(status, bodyText) {
  if (status === 422) {
    try {
      const parsed = JSON.parse(bodyText || "{}");
      const detail = parsed?.detail;
      const list = Array.isArray(detail) ? detail : [];
      const hasShortDescriptionError = list.some((item) =>
        String(item?.msg || "").toLowerCase().includes("job description is too short")
      );

      if (hasShortDescriptionError) {
        return "Could not read enough job description from this page yet. Scroll/open full job details and try again in a few seconds.";
      }
    } catch (_) {
      // Fall through to generic message.
    }
  }

  return `Server error ${status}: ${bodyText}`;
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────
async function getRateLimitStatus() {
  const data = await chrome.storage.local.get(["rateLimit"]);
  const today = getTodayKey();
  const rl = data.rateLimit || {};

  if (rl.date !== today) {
    return { remaining: DAILY_LIMIT, total: DAILY_LIMIT, date: today };
  }
  return {
    remaining: rl.remaining ?? DAILY_LIMIT,
    total: DAILY_LIMIT,
    date: today,
  };
}

async function checkAndDecrementRateLimit() {
  const { rateLimit } = await chrome.storage.local.get(["rateLimit"]);
  const today = getTodayKey();

  let rl = rateLimit || {};
  if (rl.date !== today) {
    rl = { date: today, remaining: DAILY_LIMIT };
  }

  if (rl.remaining <= 0) return false;

  rl.remaining -= 1;
  await chrome.storage.local.set({ rateLimit: rl });
  return true;
}

async function refundRateLimitToken() {
  const { rateLimit } = await chrome.storage.local.get(["rateLimit"]);
  const today = getTodayKey();
  if (rateLimit && rateLimit.date === today) {
    rateLimit.remaining = Math.min(rateLimit.remaining + 1, DAILY_LIMIT);
    await chrome.storage.local.set({ rateLimit });
  }
}

// ─── Cache Helpers ────────────────────────────────────────────────────────────
async function getCachedResult(url) {
  if (!url) return null;
  const cacheKey = `cache_${hashUrl(url)}`;
  const data = await chrome.storage.local.get([cacheKey]);
  const entry = data[cacheKey];
  if (!entry) return null;

  const isExpired = Date.now() - entry.timestamp > CACHE_TTL_MS;
  if (isExpired) {
    await chrome.storage.local.remove([cacheKey]);
    return null;
  }
  return entry.result;
}

async function cacheResult(url, result) {
  if (!url) return;
  const cacheKey = `cache_${hashUrl(url)}`;
  await chrome.storage.local.set({
    [cacheKey]: { result, timestamp: Date.now(), url },
  });
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter((k) => k.startsWith("cache_"));
  await chrome.storage.local.remove(cacheKeys);
  return { success: true, cleared: cacheKeys.length };
}

async function upsertCurrentJobForTab(tabId, jobData) {
  if (!tabId || !jobData) {
    return { success: false, error: "Missing tab/job payload." };
  }
  const { currentJobByTab = {} } = await chrome.storage.local.get(["currentJobByTab"]);
  currentJobByTab[String(tabId)] = jobData;
  await chrome.storage.local.set({
    currentJobByTab,
    // Backward compatibility for code paths still reading global key.
    currentJob: jobData,
  });
  return { success: true };
}

async function clearCurrentJobForTab(tabId) {
  if (!tabId) return { success: false, error: "Missing tab id." };
  const { currentJobByTab = {} } = await chrome.storage.local.get(["currentJobByTab"]);
  delete currentJobByTab[String(tabId)];
  await chrome.storage.local.set({ currentJobByTab });
  return { success: true };
}

async function getCurrentJobForTab(tabId) {
  if (!tabId) return { success: true, data: null };
  const { currentJobByTab = {} } = await chrome.storage.local.get(["currentJobByTab"]);
  return { success: true, data: currentJobByTab[String(tabId)] || null };
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function getSettings() {
  const data = await chrome.storage.local.get(["settings"]);
  return data.settings || {};
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

function hashUrl(url) {
  // Simple, fast hash for cache keying (not cryptographic)
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit int
  }
  return Math.abs(hash).toString(36);
}

function normalizeBackendUrl(input) {
  const normalized = String(input || "").trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("Backend URL is required.");
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_) {
    throw new Error("Backend URL is invalid.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Backend URL must start with http:// or https://");
  }

  return parsed.toString().replace(/\/+$/, "");
}

function safeSendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      return;
    }
  });
}

// ─── Startup ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.storage.local.set({
      settings: {
        backendUrl: "http://localhost:8000",
        overlayEnabled: true,
      },
    });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await clearCurrentJobForTab(tabId);
  } catch (_) {
    // Ignore storage cleanup errors.
  }
});
