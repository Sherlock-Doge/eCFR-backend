const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// ✅ Initialize Cache (Persists Data for 24 Hours)
const wordCountCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// 📌 ✅ CORS Middleware - Allows frontend access
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

// 📌 Fetch Titles (Summary Info)
app.get("/api/titles", async (req, res) => {
    try {
        console.log("📥 Fetching eCFR Titles...");
        const response = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error fetching titles:", error.message);
        res.status(500).json({ error: "Failed to fetch title data" });
    }
});

// 📌 Fetch Agencies
app.get("/api/agencies", async (req, res) => {
    try {
        console.log("📥 Fetching agency data...");
        const response = await axios.get(`${BASE_URL}/api/admin/v1/agencies.json`);
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error fetching agencies:", error.message);
        res.status(500).json({ error: "Failed to fetch agency data" });
    }
});

// 📌 Fetch Word Counts (Use Cached Data If Available)
app.get("/api/wordcounts", async (req, res) => {
    let cachedWordCounts = wordCountCache.get("wordCounts");
    if (cachedWordCounts) {
        console.log("✅ Returning cached word counts");
        return res.json(cachedWordCounts);
    } else {
        return res.json({ message: "Word counts are updating... Check back later." });
    }
});

// 📌 Background Process to Fetch Word Counts
async function fetchAndCacheWordCounts() {
    try {
        console.log("📥 Starting background word count update...");

        const titlesResponse = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        const titles = titlesResponse.data.titles;
        let wordCounts = {};

        for (let title of titles) {
            console.log(`🔍 Processing Title ${title.number}...`);

            try {
                const sectionsUrl = `${BASE_URL}/api/versioner/v1/structure/${title.latest_issue_date}/title-${title.number}.json`;
                const sectionsResponse = await axios.get(sectionsUrl);
                const sections = extractSections(sectionsResponse.data);

                let totalWordCount = 0;

                // Process Sections One by One to Reduce API Load
                for (const section of sections) {
                    try {
                        await delay(5000); // Wait 5 seconds per section to avoid 429 errors
                        const sectionContentUrl = `${BASE_URL}/api/versioner/v1/full/section/${section}`;
                        const sectionResponse = await fetchWithRetries(sectionContentUrl);

                        if (sectionResponse && sectionResponse.content) {
                            const text = extractTextFromContent(sectionResponse.content);
                            totalWordCount += countWords(text);
                        }
                    } catch (error) {
                        console.warn(`⚠️ Skipping section ${section}: ${error.message}`);
                    }
                }

                wordCounts[title.number] = totalWordCount;
                console.log(`📊 Word Count for Title ${title.number}: ${totalWordCount}`);

                // Save Partial Data After Each Title is Processed
                wordCountCache.set("wordCounts", wordCounts);
            } catch (error) {
                console.error(`⚠️ Error processing Title ${title.number}: ${error.message}`);
            }
        }

        console.log("✅ Word count update complete.");
    } catch (error) {
        console.error("🚨 Error updating word counts:", error.message);
    }
}

// 📌 Run Background Process (Starts After Server Launch)
setTimeout(fetchAndCacheWordCounts, 5000); // Start 5 seconds after launch

// 📌 Fetch with Automatic Retry (Handles 429 Errors)
async function fetchWithRetries(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.get(url);
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.warn(`⚠️ Rate limited. Retrying in ${5000 * (i + 1)}ms...`);
                await delay(5000 * (i + 1)); // Exponential backoff
            } else {
                throw error;
            }
        }
    }
    throw new Error(`Failed to fetch after ${retries} attempts`);
}

// 📌 Extract Section Identifiers from Hierarchy Data
function extractSections(structureData) {
    let sections = [];

    function traverse(node) {
        if (node.type === "section") {
            sections.push(node.identifier);
        }
        if (node.children) {
            node.children.forEach(traverse);
        }
    }

    traverse(structureData);
    return sections;
}

// 📌 Extract Plain Text from Section Content
function extractTextFromContent(content) {
    let text = "";

    if (Array.isArray(content)) {
        content.forEach(item => {
            if (typeof item === "string") {
                text += item + " ";
            } else if (typeof item === "object" && item.text) {
                text += item.text + " ";
            }
        });
    } else if (typeof content === "string") {
        text = content;
    }

    return text.trim();
}

// 📌 Count Words in a Given String
function countWords(text) {
    return text.split(/\s+/).filter(word => word.length > 0).length;
}

// 📌 Delay Function (Prevents API Spam)
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
