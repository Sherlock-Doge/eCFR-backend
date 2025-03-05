const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const { JSDOM } = require("jsdom");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// ✅ Initialize Cache (24-hour persistence for quick access)
const wordCountCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// ✅ Auto-Update Word Counts Every Week
const UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 Days

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

// 📌 Fetch Word Counts (Cache for Fast Access)
app.get("/api/wordcounts", async (req, res) => {
    let cachedWordCounts = wordCountCache.get("wordCounts");
    if (cachedWordCounts) {
        console.log("✅ Returning cached word counts");
        return res.json(cachedWordCounts);
    }

    console.log("📥 Word counts not found in cache. Fetching new data...");
    let wordCounts = await fetchAndCacheWordCounts();
    res.json(wordCounts);
});

// 📌 Fetch and Cache Word Counts (Runs Weekly)
async function fetchAndCacheWordCounts() {
    try {
        console.log("🔄 Updating word counts...");
        const titlesResponse = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        const titles = titlesResponse.data.titles;
        let wordCounts = {};

        for (let title of titles) {
            const titleNumber = title.number;
            const issueDate = title.latest_issue_date;
            console.log(`📥 Processing Title ${titleNumber} (Issued: ${issueDate})...`);

            try {
                const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${issueDate}/title-${titleNumber}.xml`;
                const xmlResponse = await axios.get(xmlUrl);
                const wordCount = countWordsFromXML(xmlResponse.data);
                wordCounts[titleNumber] = wordCount;

                console.log(`📊 Word Count for Title ${titleNumber}: ${wordCount}`);
            } catch (error) {
                console.warn(`⚠️ Error processing Title ${titleNumber}: ${error.message}`);
            }
        }

        // ✅ Save in Cache
        wordCountCache.set("wordCounts", wordCounts);
        console.log("✅ Word count update complete.");
        return wordCounts;
    } catch (error) {
        console.error("🚨 Error updating word counts:", error.message);
        return {};
    }
}

// 📌 Extract Word Count from XML Content
function countWordsFromXML(xmlData) {
    try {
        // 🏗️ Convert XML to Text
        const dom = new JSDOM(xmlData);
        const textContent = dom.window.document.body.textContent || "";

        // 🔍 Remove Special Characters, Keep Only Words
        const cleanText = textContent.replace(/[^a-zA-Z0-9\s]/g, ""); // Remove punctuation & special characters
        const words = cleanText.split(/\s+/).filter(word => word.length > 0);

        return words.length;
    } catch (error) {
        console.error("⚠️ Error parsing XML:", error.message);
        return 0;
    }
}

// 📌 Auto-Update Word Counts Every Week
setInterval(fetchAndCacheWordCounts, UPDATE_INTERVAL_MS);

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
