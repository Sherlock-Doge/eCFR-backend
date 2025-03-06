const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const { JSDOM } = require("jsdom");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// ✅ Initialize Cache (30-day persistence)
const wordCountCache = new NodeCache({ stdTTL: 2592000, checkperiod: 86400 });

// ✅ Auto-Update Word Counts Every Month (Adjusted to 24.8 days)
const UPDATE_INTERVAL_MS = 2147483647; // Max allowed by setInterval (~24.8 days)

// 📌 ✅ CORS Middleware (Fixing Fetching Issues)
app.use(cors());

// 📌 Fetch Titles (Summary Info)
app.get("/api/titles", async (req, res) => {
    try {
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
        return res.json({ title: titleNumber, wordCount: cachedWordCount });
    }

    try {
        const titlesResponse = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        const titleData = titlesResponse.data.titles.find(t => t.number.toString() === titleNumber);

        if (!titleData) {
            return res.status(404).json({ error: "Title not found" });
        }

        const issueDate = titleData.latest_issue_date;
        const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${issueDate}/title-${titleNumber}.xml`;

        const xmlResponse = await axios.get(xmlUrl, { responseType: "text" });
        const wordCount = countWordsFromXML(xmlResponse.data);

        // ✅ Cache Result
        wordCountCache.set(`wordCount-${titleNumber}`, wordCount);

        res.json({ title: titleNumber, wordCount });
    } catch (error) {
        console.error(`🚨 Error processing Title ${titleNumber}:`, error.message);
        res.status(500).json({ error: "Failed to fetch word count" });
    }
});

// 📌 Monthly Bulk Cache Refresh (with Rate-Limiting)
async function fetchAndCacheWordCounts() {
    try {
        console.log("🔄 Updating word counts for all titles...");
        const titlesResponse = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        const titles = titlesResponse.data.titles;

        for (const title of titles) {
            const titleNumber = title.number;
            const issueDate = title.latest_issue_date;

            try {
                const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${issueDate}/title-${titleNumber}.xml`;
                const xmlResponse = await axios.get(xmlUrl, { responseType: "text" });

                const wordCount = countWordsFromXML(xmlResponse.data);
                wordCountCache.set(`wordCount-${titleNumber}`, wordCount);

                console.log(`📊 Word Count for Title ${titleNumber}: ${wordCount}`);
            } catch (error) {
                console.warn(`⚠️ Error processing Title ${titleNumber}: ${error.message}`);
            }

            // ⏳ Add a delay of 5 seconds before the next request to avoid rate-limiting
            await new Promise(resolve => setTimeout(resolve, 5000));
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
        const cleanText = textContent.replace(/[^a-zA-Z0-9\s]/g, "");
        const words = cleanText.split(/\s+/).filter(word => word.length > 0);
        return words.length;
    } catch (error) {
        console.error("⚠️ Error parsing XML:", error.message);
        return 0;
    }
}

// 📌 Auto-Update Word Counts Every 24.8 Days (Fixed Timeout Issue)
setInterval(fetchAndCacheWordCounts, UPDATE_INTERVAL_MS);

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
