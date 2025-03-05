const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// 📌 ✅ Initialize Cache (Refreshes every 24 hours to reduce API calls)
const wordCountCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// 📌 ✅ CORS Middleware - Allows frontend access from GitHub Pages
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

// 📌 Fetch eCFR Titles (Summary Info)
app.get("/api/titles", async (req, res) => {
    try {
        console.log("📥 Fetching eCFR Titles...");
        const response = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        res.json(response.data.titles);
    } catch (error) {
        console.error("🚨 Error fetching titles:", error.message);
        res.status(500).json({ error: "Failed to fetch title data" });
    }
});

// 📌 Fetch Agencies List
app.get("/api/agencies", async (req, res) => {
    try {
        console.log("📥 Fetching agency data...");
        const response = await axios.get(`${BASE_URL}/api/admin/v1/agencies.json`);
        res.json(response.data.agencies);
    } catch (error) {
        console.error("🚨 Error fetching agencies:", error.message);
        res.status(500).json({ error: "Failed to fetch agency data" });
    }
});

// 📌 Fetch Ancestry Data for a Specific Title
app.get('/api/ancestry/:title', async (req, res) => {
    const titleNumber = req.params.title;
    const titlesApiUrl = `${BASE_URL}/api/versioner/v1/titles.json`;

    try {
        console.log(`📥 Fetching latest issue date for Title ${titleNumber}...`);
        const titlesResponse = await axios.get(titlesApiUrl);
        const titlesData = titlesResponse.data.titles;

        // ✅ Find the latest issue date for the requested title
        const latestTitle = titlesData.find(t => t.number == titleNumber);
        if (!latestTitle || !latestTitle.latest_issue_date) {
            throw new Error("Could not find latest issue date");
        }
        const latestDate = latestTitle.latest_issue_date;

        // 🔍 Fetch Full Hierarchical Structure (Title → Chapter → Subchapter → Part → Section)
        const structureUrl = `${BASE_URL}/api/versioner/v1/structure/${latestDate}/title-${titleNumber}.json`;
        console.log(`📥 Fetching full structure for Title ${titleNumber} from ${structureUrl}...`);

        const structureResponse = await axios.get(structureUrl);
        res.json(structureResponse.data);
    } catch (error) {
        console.error(`🚨 Error fetching structure for Title ${titleNumber}:`, error.message);
        res.status(500).json({ error: "Failed to fetch structure data" });
    }
});

// 📌 Fetch and Compute Word Counts for Each Title
app.get("/api/wordcounts", async (req, res) => {
    try {
        console.log("📥 Fetching and computing word counts...");

        // ✅ Check cache first to avoid redundant API calls
        let cachedWordCounts = wordCountCache.get("wordCounts");
        if (cachedWordCounts) {
            console.log("✅ Returning cached word counts");
            return res.json(cachedWordCounts);
        }

        // 📌 Fetch the list of Titles
        const titlesResponse = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        const titles = titlesResponse.data.titles;

        let wordCounts = {};

        // 📌 Fetch and calculate word count for each title **in parallel**
        await Promise.all(titles.map(async (title) => {
            try {
                console.log(`🔍 Processing Title ${title.number}...`);

                // 📌 Fetch structure to get all sections within the Title
                const structureUrl = `${BASE_URL}/api/versioner/v1/structure/${title.latest_issue_date}/title-${title.number}.json`;
                const structureResponse = await axios.get(structureUrl);
                const sections = extractSections(structureResponse.data);

                let totalWordCount = 0;

                // 📌 Fetch content for each section **in parallel**
                const sectionPromises = sections.map(async (section) => {
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
                });

                await Promise.all(sectionPromises);

                // 📌 Store final word count for the Title
                wordCounts[title.number] = totalWordCount;
                console.log(`📊 Word Count for Title ${title.number}: ${totalWordCount}`);

            } catch (error) {
                console.error(`⚠️ Error processing Title ${title.number}:`, error.message);
            }
        }));

        // ✅ Cache the word counts to improve performance
        wordCountCache.set("wordCounts", wordCounts);
        console.log("✅ Word counts cached successfully");

        res.json(wordCounts);
    } catch (error) {
        console.error("🚨 Error fetching word counts:", error.message);
        res.status(500).json({ error: "Failed to fetch word count data" });
    }
});

// 📌 Extract Section Identifiers from Hierarchical Structure
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

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
