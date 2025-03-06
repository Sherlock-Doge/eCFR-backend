const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const { JSDOM } = require("jsdom");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// ✅ Initialize Cache (30-day persistence for efficiency)
const wordCountCache = new NodeCache({ stdTTL: 2592000, checkperiod: 86400 });

// ✅ Auto-Update Word Counts Every Month (30 days)
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

// 📌 Fetch Word Count for a Single Title (cached individually)
app.get("/api/wordcount/:titleNumber", async (req, res) => {
    const titleNumber = req.params.titleNumber;

    // ✅ Check Cache First
    let cachedWordCount = wordCountCache.get(`wordCount-${titleNumber}`);
    if (cachedWordCount !== undefined) {
        console.log(`✅ Returning cached word count for Title ${titleNumber}`);
        return res.json({ title: titleNumber, wordCount: cachedWordCount });
    }

    try {
        console.log(`📥 Fetching word count for Title ${titleNumber}...`);

        // 🔍 Get Title Issue Date
        const titlesResponse = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        const titleData = titlesResponse.data.titles.find(t => t.number.toString() === titleNumber);

        if (!titleData) {
            console.warn(`⚠️ Title ${titleNumber} not found`);
            return res.status(404).json({ error: "Title not found" });
        }

        const issueDate = titleData.latest_issue_date;
        console.log(`📥 Processing Title ${titleNumber} (Issued: ${issueDate})...`);

        // 🔄 Fetch XML Content
        const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${issueDate}/title-${titleNumber}.xml`;
        const xmlResponse = await axios.get(xmlUrl, { responseType: "text" });

        // 🔢 Count Words
        const wordCount = countWordsFromXML(xmlResponse.data);

        // ✅ Cache Result
        wordCountCache.set(`wordCount-${titleNumber}`, wordCount);

        console.log(`📊 Word Count for Title ${titleNumber}: ${wordCount}`);
        res.json({ title: titleNumber, wordCount });
    } catch (error) {
        console.error(`🚨 Error processing Title ${titleNumber}:`, error.message);
        res.status(500).json({ error: "Failed to fetch word count" });
    }
});

// 📌 Fetch and Cache All Word Counts (Runs Monthly)
async function fetchAndCacheWordCounts() {
    try {
        console.log("🔄 Updating word counts for all titles...");
        const titlesResponse = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        const titles = titlesResponse.data.titles;
        let wordCounts = {};

        // 🏗️ Process in parallel (5 at a time to avoid overload)
        const BATCH_SIZE = 5;
        for (let i = 0; i < titles.length; i += BATCH_SIZE) {
            const batch = titles.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (title) => {
                const titleNumber = title.number;
                const issueDate = title.latest_issue_date;
                console.log(`📥 Processing Title ${titleNumber} (Issued: ${issueDate})...`);

                try {
                    const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${issueDate}/title-${titleNumber}.xml`;
                    const xmlResponse = await axios.get(xmlUrl, { responseType: "text" });
                    const wordCount = countWordsFromXML(xmlResponse.data);
                    wordCounts[titleNumber] = wordCount;

                    // ✅ Cache individual title
                    wordCountCache.set(`wordCount-${titleNumber}`, wordCount);

                    console.log(`📊 Word Count for Title ${titleNumber}: ${wordCount}`);
                } catch (error) {
                    console.warn(`⚠️ Error processing Title ${titleNumber}: ${error.message}`);
                }
            }));
        }

        console.log("✅ Monthly word count update complete.");
    } catch (error) {
        console.error("🚨 Error updating monthly word counts:", error.message);
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

// 📌 Auto-Update Word Counts Every Month
setInterval(fetchAndCacheWordCounts, UPDATE_INTERVAL_MS);

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
