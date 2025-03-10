
const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// ✅ Caches
const wordCountCache = new NodeCache({ stdTTL: 5184000, checkperiod: 86400 });
const metadataCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });
const suggestionCache = new NodeCache({ stdTTL: 43200, checkperiod: 3600 });

// ✅ Middleware
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

// ✅ Titles
app.get("/api/titles", async (req, res) => {
    try {
        let cachedTitles = metadataCache.get("titlesMetadata");
        if (!cachedTitles) {
            console.log("📥 Fetching eCFR Titles...");
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
            console.log("✅ Titles from cache");
        }
        res.json({ titles: cachedTitles });
    } catch (e) {
        console.error("🚨 Titles error:", e.message);
        res.status(500).json({ error: "Failed to fetch titles" });
    }
});

// ✅ Agencies
app.get("/api/agencies", async (req, res) => {
    try {
        console.log("📥 Fetching agency data...");
        const response = await axios.get(`${BASE_URL}/api/admin/v1/agencies.json`);
        res.json({ agencies: response.data.agencies || response.data });
    } catch (e) {
        console.error("🚨 Agencies error:", e.message);
        res.status(500).json({ error: "Failed to fetch agencies" });
    }
});

// ✅ Word Count
app.get("/api/wordcount/:titleNumber", async (req, res) => {
    const titleNumber = req.params.titleNumber;
    let cachedWordCount = wordCountCache.get(`wordCount-${titleNumber}`);
    if (cachedWordCount !== undefined) {
        console.log(`✅ Word count cache hit for Title ${titleNumber}`);
        return res.json({ title: titleNumber, wordCount: cachedWordCount });
    }

    try {
        console.log(`📥 Calculating word count for Title ${titleNumber}`);
        let cachedTitlesMetadata = metadataCache.get("titlesMetadata");
        if (!cachedTitlesMetadata) {
            const response = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
            cachedTitlesMetadata = response.data.titles.map(t => ({
                number: t.number,
                name: t.name,
                latest_issue_date: t.latest_issue_date
            }));
            metadataCache.set("titlesMetadata", cachedTitlesMetadata);
        }

        const titleData = cachedTitlesMetadata.find(t => t.number.toString() === titleNumber);
        if (!titleData) return res.status(404).json({ error: "Title not found" });
        if (titleData.name === "Reserved") return res.json({ title: titleNumber, wordCount: 0 });

        const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${titleData.latest_issue_date}/title-${titleNumber}.xml`;
        const wordCount = await streamAndCountWords(xmlUrl);
        if (wordCount === null) return res.status(500).json({ error: "Failed to fetch XML" });

        wordCountCache.set(`wordCount-${titleNumber}`, wordCount);
        res.json({ title: titleNumber, wordCount });
    } catch (e) {
        console.error(`🚨 Word Count error:`, e.message);
        res.status(500).json({ error: "Failed to calculate word count" });
    }
});

// ✅ Word Counter
async function streamAndCountWords(url) {
    try {
        const response = await axios({ method: "GET", url, responseType: "stream", timeout: 60000 });
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
    } catch (e) {
        console.error("🚨 Stream error:", e.message);
        return null;
    }
}

// ✅ Search
app.get("/api/search", async (req, res) => {
    try {
        const params = { ...req.query };
        const response = await axios.get(`${BASE_URL}/api/search/v1/results`, { params });
        res.json(response.data);
    } catch (e) {
        console.error("🚨 Search error:", e.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// ✅ Search Count
app.get("/api/search/count", async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/api/search/v1/count`, { params: req.query });
        res.json(response.data);
    } catch (e) {
        console.error("🚨 Search Count error:", e.message);
        res.status(500).json({ error: "Search count failed" });
    }
});

// ✅ Custom Suggestions
app.get("/api/search/suggestions", async (req, res) => {
    const query = (req.query.query || "").toLowerCase().trim();
    if (!query) return res.json({ suggestions: [] });

    try {
        const cacheKey = `custom-suggestions-${query}`;
        if (suggestionCache.has(cacheKey)) {
            return res.json({ suggestions: suggestionCache.get(cacheKey) });
        }

        const titles = metadataCache.get("titlesMetadata") || [];
        const agencies = metadataCache.get("agenciesMetadata") || [];

        let suggestions = [];

        titles.forEach(t => {
            if (t.name.toLowerCase().includes(query)) {
                suggestions.push(`Title ${t.number}: ${t.name}`);
            }
        });

        agencies.forEach(a => {
            if (a.name.toLowerCase().includes(query)) {
                suggestions.push(a.name);
            }
        });

        suggestions = [...new Set(suggestions)].slice(0, 10);
        suggestionCache.set(cacheKey, suggestions);
        res.json({ suggestions });
    } catch (e) {
        console.error("🚨 Suggestion error:", e.message);
        res.status(500).json({ suggestions: [] });
    }
});

// ✅ Relational Filtering API
const agencyTitleMap = {
    "Department of Agriculture": [2, 5, 7, 48],
    "Department of Homeland Security": [6],
    "Department of Defense": [32],
    "Department of Transportation": [49],
    "Department of Energy": [10],
    "Environmental Protection Agency": [40],
    "Department of the Interior": [50],
    "Department of Commerce": [15],
    "Department of Justice": [28],
    "Department of State": [22]
};

app.get("/api/agency-title-map", (req, res) => {
    res.json({ map: agencyTitleMap });
});

// ✅ Preload metadata
(async function preloadMetadata() {
    try {
        const titlesRes = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        metadataCache.set("titlesMetadata", titlesRes.data.titles.map(t => ({
            number: t.number,
            name: t.name,
            latest_issue_date: t.latest_issue_date,
            latest_amended_on: t.latest_amended_on,
            up_to_date_as_of: t.up_to_date_as_of
        })));

        const agenciesRes = await axios.get(`${BASE_URL}/api/admin/v1/agencies.json`);
        metadataCache.set("agenciesMetadata", agenciesRes.data.agencies || agenciesRes.data);

        console.log("✅ Preloaded metadata into cache");
    } catch (e) {
        console.error("🚨 Metadata preload failed:", e.message);
    }
})();

// ✅ Start server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
