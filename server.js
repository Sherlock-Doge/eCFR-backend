const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const { JSDOM } = require("jsdom");

const app = express();
const PORT = process.env.PORT || 10000;

// ✅ Your backend URL is https://ecfr-backend-service.onrender.com
// ✅ Keep BASE_URL pointed to the official eCFR API.
const BASE_URL = "https://www.ecfr.gov";

// ✅ Initialize Cache (30-day persistence for efficiency)
const wordCountCache = new NodeCache({ stdTTL: 2592000, checkperiod: 86400 });

// ✅ Auto-Update Word Counts Monthly
const UPDATE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Days

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
        const response = await axios.get(`https://www.ecfr.gov/api/versioner/v1/titles.json`);
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
        const response = await axios.get(`https://www.ecfr.gov/api/admin/v1/agencies.json`);
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error fetching agencies:", error.message);
        res.status(500).json({ error: "Failed to fetch agency data" });
    }
});

// 📌 Fetch Word Count for Individual Title (Cached)
app.get("/api/wordcount/:titleNumber", async (req, res) => {
    const titleNumber = req.params.titleNumber;

    // ✅ Check Cache First
    let cachedWordCount = wordCountCache.get(`wordCount-${titleNumber}`);
    if (cachedWordCount !== undefined) {
        console.log(`✅ Returning cached word count for Title ${titleNumber}`);
        return res.json({ title: titleNumber, wordCount: cachedWordCount });
    }

    console.log(`📥 Fetching word count for Title ${titleNumber}...`);
    try {
        const titlesResponse = await axios.get(`https://www.ecfr.gov/api/versioner/v1/titles.json`);
        const titleData = titlesResponse.data.titles.find(t => t.number.toString() === titleNumber);

        if (!titleData) {
            console.warn(`⚠️ Title ${titleNumber} not found`);
            return res.status(404).json({ error: "Title not found" });
        }

        const issueDate = titleData.latest_issue_date;
        const xmlUrl = `https://www.ecfr.gov/api/versioner/v1/full/${issueDate}/title-${titleNumber}.xml`;
        const xmlResponse = await axios.get(xmlUrl, { responseType: "text" });

        const wordCount = countWordsFromXML(xmlResponse.data);
        wordCountCache.set(`wordCount-${titleNumber}`, wordCount);
        console.log(`📊 Word Count for Title ${titleNumber}: ${wordCount}`);

        res.json({ title: titleNumber, wordCount: wordCount });
    } catch (error) {
        console.error(`🚨 Error fetching word count for Title ${titleNumber}:`, error.message);
        res.status(500).json({ error: "Failed to fetch word count" });
    }
}

// 📌 Extract Word Count from XML Content
function countWordsFromXML(xmlData) {
    try {
        const dom = new JSDOM(xmlData);
        const textContent = dom.window.document.body.textContent || "";

        // 🔍 Remove Special Characters, Keep Only Words
        const cleanText = textContent.replace(/[^a-zA-Z0-9\s]/g, "");
        const words = cleanText.split(/\s+/).filter(word => word.length > 0);

        return words.length;
    } catch (error) {
        console.error("⚠️ Error parsing XML:", error.message);
        return 0;
    }
}

// 📌 Monthly Auto-Update of All Word Counts (background)
async function fetchAndCacheAllWordCounts() {
    console.log("🔄 Starting monthly update for all Title word counts...");
    try {
        const titlesResponse = await axios.get(`https://www.ecfr.gov/api/versioner/v1/titles.json`);
        const titles = titlesResponse.data.titles;

        for (let title of titles) {
            const titleNumber = title.number;
            const issueDate = title.latest_issue_date;
            console.log(`📥 Auto-updating Title ${titleNumber}...`);

            try {
                const xmlUrl = `https://www.ecfr.gov/api/versioner/v1/full/${issueDate}/title-${titleNumber}.xml`;
                const xmlResponse = await axios.get(xmlUrl, { responseType: "text" });
                const wordCount = countWordsFromXML(xmlResponse.data);

                // Cache individual title word counts
                wordCountCache.set(`wordCount-${titleNumber}`, wordCount);
                console.log(`✅ Updated word count for Title ${titleNumber}: ${wordCount}`);
            } catch (titleError) {
                console.warn(`⚠️ Failed to auto-update Title ${titleNumber}: ${titleError.message}`);
            }
        }
        console.log("✅ Monthly auto-update completed.");
    } catch (error) {
        console.error("🚨 Error during monthly word count update:", error.message);
    }
}

// 📌 Start Auto-Update Monthly
setInterval(fetchAndCacheWordCounts, UPDATE_INTERVAL_MS);

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
