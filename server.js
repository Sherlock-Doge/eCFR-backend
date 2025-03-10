const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const sax = require("sax");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

const wordCountCache = new NodeCache({ stdTTL: 5184000, checkperiod: 86400 });
const metadataCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });
const suggestionCache = new NodeCache({ stdTTL: 43200, checkperiod: 3600 });

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

// ✅ Titles Endpoint
app.get("/api/titles", async (req, res) => {
    try {
        let titles = metadataCache.get("titlesMetadata");
        if (!titles) {
            const response = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
            titles = response.data.titles.map(t => ({
                number: t.number,
                name: t.name,
                latest_issue_date: t.latest_issue_date,
                latest_amended_on: t.latest_amended_on,
                up_to_date_as_of: t.up_to_date_as_of
            }));
            metadataCache.set("titlesMetadata", titles);
        }
        res.json({ titles });
    } catch (e) {
        console.error("🚨 Titles Error:", e.message);
        res.status(500).json({ error: "Failed to fetch titles" });
    }
});

// ✅ Agencies Endpoint
app.get("/api/agencies", async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/api/admin/v1/agencies.json`);
        const agencies = response.data.agencies || response.data;
        metadataCache.set("agenciesMetadata", agencies);
        res.json({ agencies });
    } catch (e) {
        console.error("🚨 Agencies Error:", e.message);
        res.status(500).json({ error: "Failed to fetch agencies" });
    }
});

// ✅ Title Word Count
app.get("/api/wordcount/:titleNumber", async (req, res) => {
    const titleNumber = req.params.titleNumber;
    const cacheKey = `wordCount-${titleNumber}`;
    const cached = wordCountCache.get(cacheKey);
    if (cached !== undefined) return res.json({ title: titleNumber, wordCount: cached });

    try {
        const titles = metadataCache.get("titlesMetadata") || [];
        const meta = titles.find(t => t.number == titleNumber);
        if (!meta || meta.name === "Reserved") return res.json({ title: titleNumber, wordCount: 0 });

        const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${meta.latest_issue_date}/title-${titleNumber}.xml`;
        const wordCount = await countAllWordsInXML(xmlUrl);
        wordCountCache.set(cacheKey, wordCount);
        res.json({ title: titleNumber, wordCount });
    } catch (e) {
        console.error("🚨 Title Word Count Error:", e.message);
        res.status(500).json({ error: "Failed to calculate word count" });
    }
});

// ✅ Agency Word Count (KISS logic)
app.get("/api/wordcount/agency/:slug", async (req, res) => {
    const slug = req.params.slug;
    const agencies = metadataCache.get("agenciesMetadata") || [];
    const titles = metadataCache.get("titlesMetadata") || [];
    const agency = agencies.find(a => a.slug === slug || a.name.toLowerCase().replace(/\s+/g, "-") === slug);
    if (!agency) return res.status(404).json({ error: "Agency not found" });

    const refs = agency.cfr_references || [];
    if (!refs.length) return res.json({ agency: agency.name, wordCount: 0 });

    let total = 0;
    try {
        const titleGroups = {};
        refs.forEach(r => {
            if (!titleGroups[r.title]) titleGroups[r.title] = [];
            titleGroups[r.title].push((r.chapter || r.part || "").trim());
        });

        for (const [titleNumber, ids] of Object.entries(titleGroups)) {
            const titleMeta = titles.find(t => t.number == titleNumber);
            if (!titleMeta || titleMeta.name === "Reserved") continue;

            const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${titleMeta.latest_issue_date}/title-${titleNumber}.xml`;
            const cacheKey = `agency-${slug}-title-${titleNumber}`;
            let cached = wordCountCache.get(cacheKey);
            if (cached !== undefined) {
                total += cached;
                continue;
            }

            const words = await countWordsInMatchingNodes(xmlUrl, ids);
            wordCountCache.set(cacheKey, words);
            total += words;
        }

        res.json({ agency: agency.name, wordCount: total });
    } catch (e) {
        console.error("🚨 Agency Word Count Error:", e.message);
        res.status(500).json({ error: "Failed to calculate agency word count" });
    }
});

// ✅ Stream Count - All Words (for title)
async function countAllWordsInXML(url) {
    try {
        const response = await axios({ method: "GET", url, responseType: "stream" });
        const parser = sax.createStream(true);
        let wordCount = 0;
        let buffer = "";

        parser.on("text", text => {
            buffer += text;
        });

        parser.on("closetag", tag => {
            if (tag === "P" && buffer) {
                wordCount += buffer.trim().split(/\s+/).filter(Boolean).length;
                buffer = "";
            }
        });

        return new Promise((resolve, reject) => {
            response.data.pipe(parser);
            parser.on("end", () => resolve(wordCount));
            parser.on("error", reject);
        });
    } catch (e) {
        console.error("🚨 Stream error:", e.message);
        return 0;
    }
}

// ✅ Stream Count - Matching Parts/Chapters
async function countWordsInMatchingNodes(url, targets = []) {
    try {
        const response = await axios({ method: "GET", url, responseType: "stream" });
        const parser = sax.createStream(true);
        let wordCount = 0;
        let capture = false;
        let buffer = "";

        parser.on("opentag", node => {
            if ((node.name === "CHAPTER" || node.name === "PART") && node.attributes?.N) {
                const nVal = node.attributes.N;
                capture = targets.some(t => nVal.includes(t));
            }
            if (capture && node.name === "P") buffer = "";
        });

        parser.on("text", text => {
            if (capture) buffer += text;
        });

        parser.on("closetag", tag => {
            if (capture && tag === "P") {
                wordCount += buffer.trim().split(/\s+/).filter(Boolean).length;
                buffer = "";
            }
            if (tag === "CHAPTER" || tag === "PART") capture = false;
        });

        return new Promise((resolve, reject) => {
            response.data.pipe(parser);
            parser.on("end", () => resolve(wordCount));
            parser.on("error", reject);
        });
    } catch (e) {
        console.error("🚨 Stream Matching Error:", e.message);
        return 0;
    }
}

// ✅ Search Endpoint
app.get("/api/search", async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/api/search/v1/results`, { params: req.query });
        res.json(response.data);
    } catch (e) {
        console.error("🚨 Search Error:", e.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// ✅ Search Count Endpoint
app.get("/api/search/count", async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/api/search/v1/count`, { params: req.query });
        res.json(response.data);
    } catch (e) {
        console.error("🚨 Search Count Error:", e.message);
        res.status(500).json({ error: "Search count failed" });
    }
});

// ✅ Suggestions (from local cache)
app.get("/api/search/suggestions", async (req, res) => {
    const query = (req.query.query || "").toLowerCase().trim();
    if (!query) return res.json({ suggestions: [] });

    try {
        const cacheKey = `suggestions-${query}`;
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
        console.error("🚨 Suggestions Error:", e.message);
        res.json({ suggestions: [] });
    }
});

// ✅ Metadata Preload on Boot
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

        console.log("✅ Metadata preload complete.");
    } catch (e) {
        console.error("🚨 Metadata preload error:", e.message);
    }
})();

// ✅ Server Boot
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
