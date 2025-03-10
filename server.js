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

// ✅ Word Count (Title)
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

// ✅ Word Count (Agency)
app.get("/api/wordcount/agency/:slug", async (req, res) => {
    const slug = req.params.slug;
    const agencies = metadataCache.get("agenciesMetadata") || [];
    const titlesMetadata = metadataCache.get("titlesMetadata") || [];
    const agency = agencies.find(a => a.slug === slug || a.name.toLowerCase().replace(/\s+/g, "-") === slug);
    if (!agency) return res.status(404).json({ error: "Agency not found" });

    const agencyName = agency.name;
    const agencyTitleMap = metadataCache.get("agencyTitleMap") || {};
    const relevantTitles = agencyTitleMap[agencyName] || [];

    let totalWords = 0;
    try {
        for (const title of relevantTitles) {
            let cached = wordCountCache.get(`wordCount-${title}`);
            if (cached !== undefined) {
                totalWords += cached;
            } else {
                const titleMeta = titlesMetadata.find(t => t.number == title);
                if (!titleMeta || titleMeta.name === "Reserved") continue;
                const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${titleMeta.latest_issue_date}/title-${title}.xml`;
                const words = await streamAndCountWords(xmlUrl);
                if (words !== null) {
                    wordCountCache.set(`wordCount-${title}`, words);
                    totalWords += words;
                }
            }
        }
        res.json({ agency: agencyName, wordCount: totalWords });
    } catch (e) {
        console.error("🚨 Word Count by Agency error:", e.message);
        res.status(500).json({ error: "Failed to calculate agency word count" });
    }
});

// ✅ Stream Parser
async function streamAndCountWords(url) {
    try {
        const response = await axios({ method: "GET", url, responseType: "stream", timeout: 60000 });
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

        titles.forEach(t => {
            if (t.name.toLowerCase().includes(query)) suggestions.push(`Title ${t.number}: ${t.name}`);
        });
        agencies.forEach(a => {
            if (a.name.toLowerCase().includes(query)) suggestions.push(a.name);
        });

        suggestions = [...new Set(suggestions)].slice(0, 10);
        suggestionCache.set(cacheKey, suggestions);
        res.json({ suggestions });
    } catch (e) {
        console.error("🚨 Suggestion error:", e.message);
        res.status(500).json({ suggestions: [] });
    }
});

// ✅ Relational Filtering Map
const staticMap = {
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
    res.json({ map: metadataCache.get("agencyTitleMap") || staticMap });
});

// ✅ Preload Metadata
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
        const agencies = agenciesRes.data.agencies || agenciesRes.data;
        metadataCache.set("agenciesMetadata", agencies);

        const agencyMap = {};
        agencies.forEach(a => {
            a.titles?.forEach(t => {
                if (!agencyMap[a.name]) agencyMap[a.name] = [];
                if (!agencyMap[a.name].includes(t.title_number)) {
                    agencyMap[a.name].push(t.title_number);
                }
            });
        });
        metadataCache.set("agencyTitleMap", agencyMap);

        console.log("✅ Metadata preloaded and map cached");
    } catch (e) {
        console.error("🚨 Metadata preload failed:", e.message);
    }
})();

// ✅ Server Boot
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
