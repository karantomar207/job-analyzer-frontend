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
    const backendUrl = settings.backendUrl || "http://localhost:8000";

    const response = await fetch(`${backendUrl}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobData, resumeText }),
      signal: AbortSignal.timeout(60000), // 60s timeout
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Server error ${response.status}: ${errBody}`);
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
