const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// ✅ Initialize Cache (Word Counts: 60 days, Metadata: 24 hours)
const wordCountCache = new NodeCache({ stdTTL: 5184000, checkperiod: 86400 });
const metadataCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 }); // Cache metadata for 24 hours

// 📌 ✅ CORS Middleware - Allows frontend access
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

// 📌 Fetch Titles (Summary Info) with Caching
app.get("/api/titles", async (req, res) => {
    try {
        let cachedTitles = metadataCache.get("titlesMetadata");

        if (!cachedTitles) {
            console.log("📥 Fetching eCFR Titles (Not in cache)...");
            const response = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);

            // 🏪 Store only necessary metadata (Title number + issue date)
            cachedTitles = response.data.titles.map(t => ({
                number: t.number,
                name: t.name,
                latest_issue_date: t.latest_issue_date,
                latest_amended_on: t.latest_amended_on,
                up_to_date_as_of: t.up_to_date_as_of
            }));

            metadataCache.set("titlesMetadata", cachedTitles); // ✅ Cache for 24 hours
        } else {
            console.log("✅ Using cached Titles Metadata...");
        }

        res.json({ titles: cachedTitles });
    } catch (error) {
        console.error("🚨 Error fetching titles:", error.message);
        res.status(500).json({ error: "Failed to fetch title data" });
    }
});

// 📌 Fetch Agencies (No Change)
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

// 📌 Fetch Word Count for a Single Title (cached & optimized)
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

        // 🔍 Use Cached Title Metadata
        let cachedTitlesMetadata = metadataCache.get("titlesMetadata");

        if (!cachedTitlesMetadata) {
            console.log("📥 Titles Metadata Not in Cache - Fetching...");
            const titlesResponse = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);

            cachedTitlesMetadata = titlesResponse.data.titles.map(t => ({
                number: t.number,
                name: t.name,
                latest_issue_date: t.latest_issue_date
            }));

            metadataCache.set("titlesMetadata", cachedTitlesMetadata, 86400);
        }

        // 🔍 Find the Title’s issue date
        const titleData = cachedTitlesMetadata.find(t => t.number.toString() === titleNumber);

        if (!titleData) {
            console.warn(`⚠️ Title ${titleNumber} not found`);
            return res.status(404).json({ error: "Title not found" });
        }

        if (titleData.name === "Reserved") {
            console.log(`⚠️ Title ${titleNumber} is Reserved (Empty). Returning 0 words.`);
            return res.json({ title: titleNumber, wordCount: 0 });
        }

        const issueDate = titleData.latest_issue_date;
        console.log(`📥 Processing Title ${titleNumber} (Issued: ${issueDate})...`);

        // 🔄 Fetch XML Content (Handles Large Data Efficiently)
        const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${issueDate}/title-${titleNumber}.xml`;
        const wordCount = await streamAndCountWords(xmlUrl);

        if (wordCount === null) {
            return res.status(500).json({ error: "Failed to fetch XML data" });
        }

        // ✅ Cache Result
        wordCountCache.set(`wordCount-${titleNumber}`, wordCount);

        console.log(`📊 Word Count for Title ${titleNumber}: ${wordCount}`);
        res.json({ title: titleNumber, wordCount });
    } catch (error) {
        console.error(`🚨 Error processing Title ${titleNumber}:`, error.message);
        res.status(500).json({ error: "Failed to fetch word count" });
    }
});

// 📌 Efficiently Fetch and Stream-Process XML Data
async function streamAndCountWords(url) {
    try {
        const response = await axios({
            method: "GET",
            url,
            responseType: "stream", // ✅ Stream Data Instead of Full Load
            timeout: 60000 // ✅ Increased timeout to prevent disconnects
        });

        let wordCount = 0;
        let buffer = "";

        return new Promise((resolve, reject) => {
            response.data.on("data", chunk => {
                buffer += chunk.toString();
                let words = buffer.split(/\s+/);
                wordCount += words.length - 1; // Process all but the last incomplete word
                buffer = words.pop(); // Keep last word in buffer (it might be incomplete)
            });

            response.data.on("end", () => {
                if (buffer.length > 0) wordCount++; // Add final word if any remains
                resolve(wordCount);
            });

            response.data.on("error", reject);
        });
    } catch (error) {
        console.error("🚨 Error streaming XML:", error.message);
        return null;
    }
}

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
