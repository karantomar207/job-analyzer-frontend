/**
 * JobLens AI – Job Extractor
 * Extracts job details from LinkedIn, Internshala, and generic pages via DOM parsing.
 * No external APIs. Pure DOM traversal.
 */

export const SiteType = {
    LINKEDIN: "linkedin",
    INTERNSHALA: "internshala",
    GENERIC: "generic",
    UNSUPPORTED: "unsupported",
};

// ─── Site Detection ───────────────────────────────────────────────────────────
export function detectSite(url = window.location.href) {
    if (/linkedin\.com\/jobs/.test(url)) return SiteType.LINKEDIN;
    if (/internshala\.com\/(internship|jobs)/.test(url))
        return SiteType.INTERNSHALA;
    if (hasJobKeywords()) return SiteType.GENERIC;
    return SiteType.UNSUPPORTED;
}

function hasJobKeywords() {
    const bodyText = document.body?.innerText?.toLowerCase() || "";
    const jobKeywords = [
        "responsibilities",
        "requirements",
        "qualifications",
        "about the role",
        "about the job",
        "job description",
        "what you will do",
        "what we're looking for",
        "skills required",
        "experience required",
    ];
    return jobKeywords.some((kw) => bodyText.includes(kw));
}

// ─── Main Extractor ───────────────────────────────────────────────────────────
export function extractJobData() {
    const site = detectSite();
    let data;

    switch (site) {
        case SiteType.LINKEDIN:
            data = extractLinkedIn();
            break;
        case SiteType.INTERNSHALA:
            data = extractInternshala();
            break;
        case SiteType.GENERIC:
            data = extractGeneric();
            break;
        default:
            return null;
    }

    if (!data) return null;

    return {
        ...data,
        site,
        url: window.location.href,
        extractedAt: new Date().toISOString(),
    };
}

// ─── LinkedIn Extractor ───────────────────────────────────────────────────────
function extractLinkedIn() {
    try {
        const getText = (sel) =>
            document.querySelector(sel)?.innerText?.trim() || "";

        const title =
            getText(".job-details-jobs-unified-top-card__job-title") ||
            getText(".jobs-unified-top-card__job-title") ||
            getText("h1.t-24") ||
            getText("h1");

        const company =
            getText(".job-details-jobs-unified-top-card__company-name") ||
            getText(".jobs-unified-top-card__company-name") ||
            getText(".topcard__org-name-link") ||
            getText(".jobs-unified-top-card__subtitle-primary-grouping a");

        const location =
            getText(".job-details-jobs-unified-top-card__bullet") ||
            getText(".jobs-unified-top-card__bullet") ||
            getText(".topcard__flavor--bullet");

        // Description – try multiple container selectors
        const descEl =
            document.querySelector(".jobs-description__content") ||
            document.querySelector(".jobs-description") ||
            document.querySelector(".job-view-layout") ||
            document.querySelector("#job-details");
        const description = descEl?.innerText?.trim() || "";

        // Experience – parse from description
        const experience = parseExperience(description);

        // Salary
        const salaryEl = document.querySelector(
            ".jobs-unified-top-card__job-insight"
        );
        const salary = extractSalary(salaryEl?.innerText || description);

        // Skills chips (LinkedIn sometimes renders them)
        const skillEls = document.querySelectorAll(".job-details-skill-match-status-list__unmatched-skill-text, .job-details-preferences-and-skills__pill");
        const skills = [...skillEls].map((el) => el.innerText.trim()).filter(Boolean);

        return {
            title,
            company,
            location,
            experience,
            salary,
            description,
            skills,
        };
    } catch (e) {
        console.error("[JobLens] LinkedIn extraction error:", e);
        return extractGeneric();
    }
}

// ─── Internshala Extractor ────────────────────────────────────────────────────
function extractInternshala() {
    try {
        const getText = (sel) =>
            document.querySelector(sel)?.innerText?.trim() || "";

        const title =
            getText(".profile h1") ||
            getText(".heading_4_5.profile") ||
            getText("h1.job-internship-name") ||
            getText("h1");

        const company =
            getText(".company-name") ||
            getText(".link_display_like_text .heading_6") ||
            getText(".internship_other_details_container .heading_6");

        const location =
            getText(".location_link") ||
            getText(".other_detail_item .item_body") ||
            "";

        const descWrapper =
            document.querySelector("#about_internship") ||
            document.querySelector(".internship-description") ||
            document.querySelector(".about_company_text_container");

        const description = descWrapper?.innerText?.trim() || document.body.innerText.trim().slice(0, 5000);

        const experience = parseExperience(description);
        const salary =
            extractSalary(getText(".stipend_container") || description);

        const skillEls = document.querySelectorAll(
            ".round_tabs .round_without_icon, .tags_container .tag"
        );
        const skills = [...skillEls].map((el) => el.innerText.trim()).filter(Boolean);

        return { title, company, location, experience, salary, description, skills };
    } catch (e) {
        console.error("[JobLens] Internshala extraction error:", e);
        return extractGeneric();
    }
}

// ─── Generic Extractor ────────────────────────────────────────────────────────
function extractGeneric() {
    try {
        // Title: prefer structured elements
        const title =
            document.querySelector("h1")?.innerText?.trim() ||
            document.querySelector('[class*="title"]')?.innerText?.trim() ||
            document.title;

        // Company: look for schema.org or common patterns
        const companyEl =
            document.querySelector('[itemprop="hiringOrganization"]') ||
            document.querySelector('[class*="company"]') ||
            document.querySelector('[class*="employer"]');
        const company = companyEl?.innerText?.trim() || "";

        // Location
        const locationEl =
            document.querySelector('[itemprop="jobLocation"]') ||
            document.querySelector('[class*="location"]');
        const location = locationEl?.innerText?.trim() || "";

        // Description: largest text block likely containing job content
        const descEl =
            document.querySelector('[class*="description"]') ||
            document.querySelector('[class*="job-detail"]') ||
            document.querySelector("main") ||
            document.querySelector("article") ||
            document.body;

        const description = extractMainContent(descEl);
        const experience = parseExperience(description);
        const salary = extractSalary(description);

        return { title, company, location, experience, salary, description, skills: [] };
    } catch (e) {
        console.error("[JobLens] Generic extraction error:", e);
        return null;
    }
}

// ─── Content Helpers ──────────────────────────────────────────────────────────

/** Extract the most relevant text block from an element, filtering nav/footer noise */
function extractMainContent(el) {
    if (!el) return "";
    // Clone so we don't mutate the page
    const clone = el.cloneNode(true);
    // Remove non-content elements
    ["nav", "header", "footer", "script", "style", "noscript", "aside"].forEach(
        (tag) => clone.querySelectorAll(tag).forEach((n) => n.remove())
    );
    return clone.innerText?.trim().slice(0, 8000) || "";
}

/** Parse experience years from text */
function parseExperience(text) {
    const patterns = [
        /(\d+)\+?\s*(?:to|-|–)\s*(\d+)\s*years?/i,
        /(\d+)\+?\s*years?\s*(?:of\s+)?(?:experience|exp)/i,
        /experience[:\s]+(\d+)\+?\s*years?/i,
        /minimum\s+(\d+)\s*years?/i,
        /at least\s+(\d+)\s*years?/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m) {
            return m[2] ? `${m[1]}-${m[2]} years` : `${m[1]}+ years`;
        }
    }
    return "Not specified";
}

/** Extract salary info from text */
function extractSalary(text) {
    const patterns = [
        /(?:₹|rs\.?|inr)\s*[\d,]+(?:\s*-\s*[\d,]+)?\s*(?:lpa|lakh|k\/month|\/month|per annum)?/i,
        /\$\s*[\d,]+(?:\s*-\s*[\d,]+)?\s*(?:k?\/year|k?\/month|k\s)/i,
        /salary[:\s]+[\d,₹$]+[^\n]*/i,
        /compensation[:\s]+[^\n]*/i,
        /stipend[:\s]+[\d,₹$]+[^\n]*/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m) return m[0].trim();
    }
    return "Not disclosed";
}
