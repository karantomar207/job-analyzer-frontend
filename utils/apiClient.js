/**
 * JobLens AI – API Client
 * Communicates with background service worker which proxies to the backend.
 * Handles caching, retries, and error normalization.
 */

// ─── Core Communication ───────────────────────────────────────────────────────

/**
 * Send a message to the background service worker.
 * @param {string} type
 * @param {object} payload
 * @returns {Promise<object>}
 */
function sendToBackground(type, payload = {}) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Request AI analysis from the backend via background worker.
 * @param {{ jobData: object, resumeText: string, url: string }} options
 * @returns {Promise<AnalysisResult>}
 */
export async function analyzeJob({ jobData, resumeText, url }) {
    if (!jobData || !resumeText) {
        throw new Error("Both job data and resume text are required.");
    }

    const response = await sendToBackground("ANALYZE_JOB", {
        jobData,
        resumeText,
        url,
    });

    if (!response.success) {
        const err = new Error(response.error || "Analysis failed");
        err.rateLimited = response.rateLimited || false;
        throw err;
    }

    return {
        ...response.data,
        fromCache: response.fromCache || false,
    };
}

/**
 * Get the current rate limit status.
 * @returns {Promise<{ remaining: number, total: number, date: string }>}
 */
export async function getRateLimitStatus() {
    return sendToBackground("GET_RATE_LIMIT_STATUS");
}

/**
 * Get a cached analysis result for a URL (if available).
 * @param {string} url
 * @returns {Promise<object|null>}
 */
export async function getCachedResult(url) {
    const response = await sendToBackground("GET_CACHED_RESULT", { url });
    return response || null;
}

/**
 * Clear all cached analysis results.
 * @returns {Promise<{ cleared: number }>}
 */
export async function clearCache() {
    return sendToBackground("CLEAR_CACHE");
}

/**
 * Verify backend URL by calling backend /health.
 * @param {string} url
 * @returns {Promise<{success:boolean,error?:string,backendUrl?:string,status?:string,service?:string}>}
 */
export async function verifyBackendUrl(url) {
    return sendToBackground("VERIFY_BACKEND_URL", { url });
}

// ─── Resume Storage ───────────────────────────────────────────────────────────

/**
 * Save resume data to chrome.storage.local (never leaves the device).
 */
export async function saveResume(rawText, parsed) {
    await chrome.storage.local.set({
        resume: {
            raw: rawText,
            parsed,
            savedAt: new Date().toISOString(),
        },
    });
}

/**
 * Load saved resume from chrome.storage.local.
 * @returns {Promise<{ raw: string, parsed: object, savedAt: string }|null>}
 */
export async function loadResume() {
    const data = await chrome.storage.local.get(["resume"]);
    return data.resume || null;
}

/**
 * Delete the stored resume.
 */
export async function deleteResume() {
    await chrome.storage.local.remove(["resume"]);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings() {
    const data = await chrome.storage.local.get(["settings"]);
    return data.settings || { backendUrl: "http://localhost:8000", overlayEnabled: true };
}

export async function saveSettings(settings) {
    const current = await getSettings();
    await chrome.storage.local.set({ settings: { ...current, ...settings } });
}

// ─── Analysis History ─────────────────────────────────────────────────────────

export async function saveAnalysisToHistory(jobData, result) {
    const { history = [] } = await chrome.storage.local.get(["history"]);

    const entry = {
        id: Date.now().toString(),
        jobTitle: jobData.title,
        company: jobData.company,
        matchPercentage: result.match_percentage,
        url: jobData.url,
        analyzedAt: new Date().toISOString(),
    };

    // Keep last 50 entries
    history.unshift(entry);
    if (history.length > 50) history.pop();

    await chrome.storage.local.set({ history });
    return entry;
}

export async function getAnalysisHistory() {
    const { history = [] } = await chrome.storage.local.get(["history"]);
    return history;
}
