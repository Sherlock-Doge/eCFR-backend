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
            console.log("📥 Fetching Titles...");
            const response = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
            cachedTitles = response.data.titles.map(t => ({
                number: t.number,
                name: t.name,
                latest_issue_date: t.latest_issue_date,
                latest_amended_on: t.latest_amended_on,
                up_to_date_as_of: t.up_to_date_as_of
            }));
            metadataCache.set("titlesMetadata", cachedTitles);
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
        let cachedAgencies = metadataCache.get("agenciesMetadata");
        if (!cachedAgencies) {
            console.log("📥 Fetching Agencies...");
            const response = await axios.get(`${BASE_URL}/api/admin/v1/agencies.json`);
            cachedAgencies = response.data.agencies || response.data;
            metadataCache.set("agenciesMetadata", cachedAgencies);
        }
        res.json({ agencies: cachedAgencies });
    } catch (e) {
        console.error("🚨 Agencies error:", e.message);
        res.status(500).json({ error: "Failed to fetch agencies" });
    }
});

// ✅ Agency → Title Map
app.get("/api/agency-title-map", async (req, res) => {
    try {
        const agencies = metadataCache.get("agenciesMetadata") || [];
        const titleMap = {};

        agencies.forEach(a => {
            if (a.name && a.titles) {
                titleMap[a.name] = Array.from(new Set(a.titles.map(t => t.number)));
            }
        });

        res.json({ map: titleMap });
    } catch (e) {
        console.error("🚨 AgencyTitleMap error:", e.message);
        res.status(500).json({ error: "Failed to build map" });
    }
});

// ✅ Word Count
app.get("/api/wordcount/:titleNumber", async (req, res) => {
    const titleNumber = req.params.titleNumber;
    let cachedWordCount = wordCountCache.get(`wordCount-${titleNumber}`);
    if (cachedWordCount !== undefined) {
        return res.json({ title: titleNumber, wordCount: cachedWordCount });
    }

    try {
        const titles = metadataCache.get("titlesMetadata") || [];
        const titleData = titles.find(t => t.number.toString() === titleNumber);
        if (!titleData || titleData.name === "Reserved") return res.json({ title: titleNumber, wordCount: 0 });

        const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${titleData.latest_issue_date}/title-${titleNumber}.xml`;
        const count = await streamAndCountWords(xmlUrl);
        if (count !== null) {
            wordCountCache.set(`wordCount-${titleNumber}`, count);
            return res.json({ title: titleNumber, wordCount: count });
        }
        return res.status(500).json({ error: "Stream error" });
    } catch (e) {
        console.error("🚨 Word Count error:", e.message);
        return res.status(500).json({ error: "Word count failed" });
    }
});

async function streamAndCountWords(url) {
    try {
        const response = await axios({ method: "GET", url, responseType: "stream" });
        let wordCount = 0, buffer = "";
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
        const response = await axios.get(`${BASE_URL}/api/search/v1/results`, { params: req.query });
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

// ✅ Suggestions
app.get("/api/search/suggestions", async (req, res) => {
    const query = (req.query.query || "").toLowerCase().trim();
    if (!query) return res.json({ suggestions: [] });

    try {
        const cacheKey = `custom-suggestions-${query}`;
        if (suggestionCache.has(cacheKey)) return res.json({ suggestions: suggestionCache.get(cacheKey) });

        const titles = metadataCache.get("titlesMetadata") || [];
        const agencies = metadataCache.get("agenciesMetadata") || [];
        let suggestions = [];

        titles.forEach(t => { if (t.name.toLowerCase().includes(query)) suggestions.push(`Title ${t.number}: ${t.name}`); });
        agencies.forEach(a => { if (a.name.toLowerCase().includes(query)) suggestions.push(a.name); });

        suggestions = [...new Set(suggestions)].slice(0, 10);
        suggestionCache.set(cacheKey, suggestions);
        res.json({ suggestions });
    } catch (e) {
        console.error("🚨 Suggestion error:", e.message);
        res.status(500).json({ suggestions: [] });
    }
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

// ✅ Start
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
