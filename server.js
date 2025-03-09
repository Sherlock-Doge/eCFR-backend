const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// ✅ Initialize Cache (Word Counts: 60 days, Metadata: 24 hours, Search Suggestions: 12 hours)
const wordCountCache = new NodeCache({ stdTTL: 5184000, checkperiod: 86400 });
const metadataCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });
const suggestionCache = new NodeCache({ stdTTL: 43200, checkperiod: 3600 });

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
            cachedTitles = response.data.titles.map(t => ({
                number: t.number,
                name: t.name,
                latest_issue_date: t.latest_issue_date,
                latest_amended_on: t.latest_amended_on,
                up_to_date_as_of: t.up_to_date_as_of
            }));
            metadataCache.set("titlesMetadata", cachedTitles);
        } else {
            console.log("✅ Using cached Titles Metadata...");
        }

        res.json({ titles: cachedTitles });
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

// 📌 Fetch Word Count for a Single Title
app.get("/api/wordcount/:titleNumber", async (req, res) => {
    const titleNumber = req.params.titleNumber;
    let cachedWordCount = wordCountCache.get(`wordCount-${titleNumber}`);
    if (cachedWordCount !== undefined) {
        console.log(`✅ Returning cached word count for Title ${titleNumber}`);
        return res.json({ title: titleNumber, wordCount: cachedWordCount });
    }

    try {
        console.log(`📥 Fetching word count for Title ${titleNumber}...`);
        let cachedTitlesMetadata = metadataCache.get("titlesMetadata");

        if (!cachedTitlesMetadata) {
            const titlesResponse = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
            cachedTitlesMetadata = titlesResponse.data.titles.map(t => ({
                number: t.number,
                name: t.name,
                latest_issue_date: t.latest_issue_date
            }));
            metadataCache.set("titlesMetadata", cachedTitlesMetadata);
        }

        const titleData = cachedTitlesMetadata.find(t => t.number.toString() === titleNumber);
        if (!titleData) return res.status(404).json({ error: "Title not found" });
        if (titleData.name === "Reserved") return res.json({ title: titleNumber, wordCount: 0 });

        const issueDate = titleData.latest_issue_date;
        const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${issueDate}/title-${titleNumber}.xml`;
        const wordCount = await streamAndCountWords(xmlUrl);

        if (wordCount === null) return res.status(500).json({ error: "Failed to fetch XML data" });

        wordCountCache.set(`wordCount-${titleNumber}`, wordCount);
        res.json({ title: titleNumber, wordCount });
    } catch (error) {
        console.error(`🚨 Error processing Title ${titleNumber}:`, error.message);
        res.status(500).json({ error: "Failed to fetch word count" });
    }
});

// 📌 Efficient Stream Word Count
async function streamAndCountWords(url) {
    try {
        const response = await axios({
            method: "GET",
            url,
            responseType: "stream",
            timeout: 60000
        });

        let wordCount = 0;
        let buffer = "";

        return new Promise((resolve, reject) => {
            response.data.on("data", chunk => {
                buffer += chunk.toString();
                const words = buffer.split(/\s+/);
                wordCount += words.length - 1;
                buffer = words.pop();
            });

            response.data.on("end", () => {
                if (buffer.length > 0) wordCount++;
                resolve(wordCount);
            });

            response.data.on("error", reject);
        });
    } catch (error) {
        console.error("🚨 Error streaming XML:", error.message);
        return null;
    }
}

// ✅ 🔍 SEARCH API: /api/search
app.get("/api/search", async (req, res) => {
    try {
        const params = { ...req.query };
        const response = await axios.get(`${BASE_URL}/api/search/v1/results`, { params });
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error in /api/search:", error.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// ✅ 🔍 SEARCH COUNT API: /api/search/count
app.get("/api/search/count", async (req, res) => {
    try {
        const params = { ...req.query };
        const response = await axios.get(`${BASE_URL}/api/search/v1/count`, { params });
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error in /api/search/count:", error.message);
        res.status(500).json({ error: "Search count failed" });
    }
});

// ✅ 🔍 SEARCH SUGGESTIONS API: /api/search/suggestions
app.get("/api/search/suggestions", async (req, res) => {
    const query = req.query.query || "";
    const cacheKey = `suggestions-${query.toLowerCase()}`;

    try {
        if (suggestionCache.has(cacheKey)) {
            return res.json(suggestionCache.get(cacheKey));
        }

        const params = { query };
        const response = await axios.get(`${BASE_URL}/api/search/v1/suggestions`, { params });

        suggestionCache.set(cacheKey, response.data);
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error in /api/search/suggestions:", error.message);
        res.status(500).json({ error: "Search suggestions failed" });
    }
});

// 📌 Start Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
