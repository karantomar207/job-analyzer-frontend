/**
 * JobLens AI – Resume Parser
 * Parses PDF, DOCX, and plain text resumes.
 * PDF: uses pdf.js CDN (loaded via content script)
 * DOCX: uses mammoth.js CDN
 * All processing is client-side only.
 */

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * Parse a resume from a File object or raw text.
 * @param {File|string} input
 * @returns {Promise<{ raw: string, parsed: ParsedResume }>}
 */
export async function parseResume(input) {
    let rawText = "";

    if (typeof input === "string") {
        rawText = input.trim();
    } else if (input instanceof File) {
        rawText = await extractTextFromFile(input);
    } else {
        throw new Error("Invalid input: must be File or string");
    }

    if (!rawText || rawText.length < 50) {
        throw new Error("Resume text is too short. Please upload a valid resume.");
    }

    const parsed = extractResumeFields(rawText);
    return { raw: rawText, parsed };
}

// ─── File Type Handlers ───────────────────────────────────────────────────────

async function extractTextFromFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();

    if (ext === "pdf") {
        return extractPdfText(file);
    } else if (ext === "docx" || ext === "doc") {
        return extractDocxText(file);
    } else if (ext === "txt") {
        return file.text();
    } else {
        throw new Error(`Unsupported file type: .${ext}. Use PDF, DOCX, or TXT.`);
    }
}

async function extractPdfText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const typedArray = new Uint8Array(e.target.result);

                // pdf.js must be available globally (loaded via popup)
                if (!window.pdfjsLib) {
                    reject(new Error("PDF parser not available. Please try pasting your resume text."));
                    return;
                }

                window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                    chrome.runtime.getURL("libs/pdf.worker.min.js");

                const pdf = await window.pdfjsLib.getDocument({ data: typedArray }).promise;
                const pages = [];

                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const content = await page.getTextContent();
                    const pageText = content.items.map((item) => item.str).join(" ");
                    pages.push(pageText);
                }

                resolve(pages.join("\n\n"));
            } catch (err) {
                reject(new Error(`PDF parsing failed: ${err.message}`));
            }
        };
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsArrayBuffer(file);
    });
}

async function extractDocxText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                if (!window.mammoth) {
                    reject(new Error("DOCX parser not available. Please paste your resume text."));
                    return;
                }
                const result = await window.mammoth.extractRawText({ arrayBuffer: e.target.result });
                resolve(result.value);
            } catch (err) {
                reject(new Error(`DOCX parsing failed: ${err.message}`));
            }
        };
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsArrayBuffer(file);
    });
}

// ─── Field Extraction ─────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   skills: string[],
 *   education: string[],
 *   experienceYears: number,
 *   projects: string[],
 *   certifications: string[],
 *   email: string,
 *   name: string
 * }} ParsedResume
 */

function extractResumeFields(text) {
    return {
        name: extractName(text),
        email: extractEmail(text),
        skills: extractSkills(text),
        education: extractEducation(text),
        experienceYears: extractExperienceYears(text),
        projects: extractProjects(text),
        certifications: extractCertifications(text),
    };
}

function extractName(text) {
    // Name is typically the first non-blank, non-keyword line
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 5)) {
        // Skip lines that look like contact info or sections
        if (/[@|linkedin|github|phone|mobile|\d{10}]/i.test(line)) continue;
        if (line.length > 50 || line.length < 2) continue;
        if (/^(resume|curriculum|cv|objective|summary)/i.test(line)) continue;
        return line;
    }
    return "";
}

function extractEmail(text) {
    const m = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    return m ? m[0] : "";
}

function extractSkills(text) {
    // Find skills section
    const sectionText = extractSection(text, [
        "skills",
        "technical skills",
        "core competencies",
        "technologies",
        "tech stack",
        "tools",
        "competencies",
    ]);

    const rawText = sectionText || text;
    const skills = new Set();

    // Common tech skills to scan for
    const techPatterns = [
        // Languages
        /\b(python|javascript|typescript|java|c\+\+|c#|ruby|go|rust|scala|php|swift|kotlin|r|matlab|bash|shell)\b/gi,
        // Web/Frontend
        /\b(react(?:\.js)?|vue(?:\.js)?|angular|next(?:\.js)?|nuxt|svelte|html5?|css3?|sass|less|tailwind|bootstrap|jquery|webpack|vite)\b/gi,
        // Backend
        /\b(node(?:\.js)?|express(?:\.js)?|django|flask|fastapi|spring|laravel|rails|asp\.net|graphql|rest|restful)\b/gi,
        // Databases
        /\b(mysql|postgresql|postgres|mongodb|redis|elasticsearch|sqlite|cassandra|dynamodb|firebase|supabase|prisma)\b/gi,
        // Cloud/DevOps
        /\b(aws|gcp|azure|docker|kubernetes|k8s|ci\/cd|jenkins|github actions|terraform|ansible|linux|nginx|apache)\b/gi,
        // ML/AI
        /\b(tensorflow|pytorch|scikit-learn|pandas|numpy|keras|hugging face|llm|nlp|machine learning|deep learning|data science)\b/gi,
        // Tools
        /\b(git|github|gitlab|jira|confluence|figma|postman|swagger|vs code|intellij|vim)\b/gi,
    ];

    for (const pattern of techPatterns) {
        const matches = rawText.matchAll(pattern);
        for (const m of matches) {
            skills.add(m[0].toLowerCase().trim());
        }
    }

    // Also extract comma/bullet separated items from skills section
    if (sectionText) {
        sectionText
            .split(/[,\n\|•·▪◦\t]/)
            .map((s) => s.replace(/[^\w\s.#+]/g, "").trim())
            .filter((s) => s.length > 1 && s.length < 40)
            .forEach((s) => skills.add(s.toLowerCase()));
    }

    return [...skills].filter((s) => s.trim().length > 1).slice(0, 60);
}

function extractEducation(text) {
    const sectionText = extractSection(text, ["education", "academic", "degree", "qualification"]);
    if (!sectionText) return [];

    return sectionText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 5 && l.length < 200)
        .filter((l) =>
            /(b\.?tech|m\.?tech|b\.?e|m\.?e|b\.?sc|m\.?sc|bca|mca|bachelor|master|phd|diploma|engineering|computer science|information technology|\d{4})/i.test(l)
        )
        .slice(0, 5);
}

function extractExperienceYears(text) {
    const patterns = [
        /(\d+\.?\d*)\+?\s*years?\s+(?:of\s+)?(?:experience|exp|work)/i,
        /experience[:\s]+(\d+\.?\d*)\+?\s*years?/i,
        // Infer from date ranges in work history
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m) return parseFloat(m[1]);
    }

    // Try to infer from consecutive year ranges
    const yearMatches = text.matchAll(/\b(20\d{2})\s*[-–]\s*(20\d{2}|present|current)\b/gi);
    let totalMonths = 0;
    for (const m of yearMatches) {
        const start = parseInt(m[1]);
        const end = m[2].match(/present|current/i) ? new Date().getFullYear() : parseInt(m[2]);
        totalMonths += (end - start) * 12;
    }
    if (totalMonths > 0) return Math.round(totalMonths / 12);

    return 0;
}

function extractProjects(text) {
    const sectionText = extractSection(text, ["projects", "personal projects", "side projects", "portfolio"]);
    if (!sectionText) return [];

    // Extract project names (typically bold or first word of line after a bullet)
    return sectionText
        .split("\n")
        .map((l) => l.replace(/^[•·▪◦\-*]\s*/, "").trim())
        .filter((l) => l.length > 5 && l.length < 150)
        .slice(0, 8);
}

function extractCertifications(text) {
    const sectionText = extractSection(text, [
        "certifications",
        "certificates",
        "courses",
        "achievements",
        "awards",
    ]);
    if (!sectionText) return [];

    return sectionText
        .split("\n")
        .map((l) => l.replace(/^[•·▪◦\-*]\s*/, "").trim())
        .filter((l) => l.length > 5 && l.length < 150)
        .slice(0, 8);
}

// ─── Section Extractor ────────────────────────────────────────────────────────

function extractSection(text, headings) {
    const lines = text.split("\n");
    let inSection = false;
    const sectionLines = [];

    // Common next-section anchors
    const allSectionHeaders = [
        "experience", "work experience", "employment", "education", "skills",
        "technical skills", "projects", "certifications", "achievements",
        "summary", "objective", "contact", "references", "publications", "languages",
    ];

    for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase().trim();

        if (!inSection) {
            if (headings.some((h) => lower === h || lower.startsWith(h + ":") || lower.startsWith(h + " "))) {
                inSection = true;
            }
        } else {
            // Stop if we hit another major section
            if (
                allSectionHeaders.some(
                    (h) => (lower === h || lower.startsWith(h + ":")) && !headings.includes(h)
                )
            ) {
                break;
            }
            sectionLines.push(lines[i]);
        }
    }

    return sectionLines.join("\n").trim();
}
