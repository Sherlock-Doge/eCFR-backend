const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// ✅ Initialize Cache (Set to refresh every 24 hours)
const wordCountCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// 📌 ✅ CORS Middleware - Allows frontend access from GitHub Pages
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

// 📌 Fetch latest issue date first, then fetch FULL STRUCTURE hierarchy
app.get('/api/ancestry/:title', async (req, res) => {
    const titleNumber = req.params.title;
    const titlesApiUrl = `${BASE_URL}/api/versioner/v1/titles.json`;

    try {
        console.log(`📥 Fetching latest issue date for Title ${titleNumber}...`);
        const titlesResponse = await axios.get(titlesApiUrl);
        const titlesData = titlesResponse.data.titles;

        const latestTitle = titlesData.find(t => t.number == titleNumber);
        if (!latestTitle || !latestTitle.latest_issue_date) {
            throw new Error("Could not find latest issue date");
        }
        const latestDate = latestTitle.latest_issue_date;

        const structureUrl = `${BASE_URL}/api/versioner/v1/structure/${latestDate}/title-${titleNumber}.json`;
        console.log(`📥 Fetching full structure for Title ${titleNumber} from ${structureUrl}...`);

        const structureResponse = await axios.get(structureUrl);
        res.json(structureResponse.data);
    } catch (error) {
        console.error(`🚨 Error fetching structure for Title ${titleNumber}:`, error.message);
        res.status(500).json({ error: "Failed to fetch structure data" });
    }
});

// 📌 Fetch and Compute Word Counts per Title
app.get("/api/wordcounts", async (req, res) => {
    try {
        console.log("📥 Fetching and computing word counts...");

        // Check cache first
        let cachedWordCounts = wordCountCache.get("wordCounts");
        if (cachedWordCounts) {
            console.log("✅ Returning cached word counts");
            return res.json(cachedWordCounts);
        }

        // Fetch Title list
        const titlesResponse = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        const titles = titlesResponse.data.titles;

        let wordCounts = {};

        // Loop through each Title and fetch its sections
        await Promise.all(titles.map(async (title) => {
            try {
                console.log(`🔍 Processing Title ${title.number}...`);

                const sectionsUrl = `${BASE_URL}/api/versioner/v1/structure/${title.latest_issue_date}/title-${title.number}.json`;
                const sectionsResponse = await axios.get(sectionsUrl);
                const sections = extractSections(sectionsResponse.data);

                let totalWordCount = 0;

                await Promise.all(sections.map(async (section) => {
                    try {
                        const sectionContentUrl = `${BASE_URL}/api/versioner/v1/full/section/${section}`;
                        const sectionResponse = await axios.get(sectionContentUrl);

                        if (sectionResponse.data && sectionResponse.data.content) {
                            const text = extractTextFromContent(sectionResponse.data.content);
                            totalWordCount += countWords(text);
                        }
                    } catch (error) {
                        console.error(`⚠️ Error fetching section ${section}:`, error.message);
                    }
                }));

                wordCounts[title.number] = totalWordCount;
                console.log(`📊 Word Count for Title ${title.number}: ${totalWordCount}`);

            } catch (error) {
                console.error(`⚠️ Error processing Title ${title.number}:`, error.message);
            }
        }));

        // Cache the results
        wordCountCache.set("wordCounts", wordCounts);
        console.log("✅ Word counts cached");

        res.json(wordCounts);
    } catch (error) {
        console.error("🚨 Error fetching word counts:", error.message);
        res.status(500).json({ error: "Failed to fetch word count data" });
    }
});

// 📌 Extract section identifiers from hierarchy data
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

// 📌 Extract plain text from section content
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

// 📌 Count words in a given string
function countWords(text) {
    return text.split(/\s+/).filter(word => word.length > 0).length;
}

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
