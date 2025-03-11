// eCFR Analyzer Backend – FINAL XML-PARSED VERSION (NO PUPPETEER)
const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const sax = require("sax");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";
const VERSIONER = `${BASE_URL}/api/versioner/v1`;
const ADMIN = `${BASE_URL}/api/admin/v1`;

const wordCountCache = new NodeCache({ stdTTL: 5184000, checkperiod: 86400 });
const metadataCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });
const suggestionCache = new NodeCache({ stdTTL: 43200, checkperiod: 3600 });

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// ===================== Titles Endpoint =====================
app.get("/api/titles", async (req, res) => {
  try {
    let cachedTitles = metadataCache.get("titlesMetadata");
    if (!cachedTitles) {
      const response = await axios.get(`${VERSIONER}/titles.json`);
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

// ===================== Agencies Endpoint =====================
app.get("/api/agencies", async (req, res) => {
  try {
    const response = await axios.get(`${ADMIN}/agencies.json`);
    const agencies = response.data.agencies || response.data;
    metadataCache.set("agenciesMetadata", agencies);
    res.json({ agencies });
  } catch (e) {
    console.error("🚨 Agencies error:", e.message);
    res.status(500).json({ error: "Failed to fetch agencies" });
  }
});

// ===================== Word Count by Title =====================
app.get("/api/wordcount/:titleNumber", async (req, res) => {
  const titleNumber = req.params.titleNumber;
  const cacheKey = `wordCount-${titleNumber}`;
  const cached = wordCountCache.get(cacheKey);
  if (cached !== undefined) return res.json({ title: titleNumber, wordCount: cached });

  try {
    const titles = metadataCache.get("titlesMetadata") || [];
    const meta = titles.find(t => t.number.toString() === titleNumber);
    if (!meta || meta.name === "Reserved") return res.json({ title: titleNumber, wordCount: 0 });

    const xmlUrl = `${VERSIONER}/full/${meta.latest_issue_date}/title-${titleNumber}.xml`;
    const wordCount = await streamAndCountWords(xmlUrl);
    wordCountCache.set(cacheKey, wordCount);
    res.json({ title: titleNumber, wordCount });
  } catch (e) {
    console.error("🚨 Title Word Count Error:", e.message);
    res.status(500).json({ error: "Failed to count words" });
  }
});

// ===================== Word Count by Agency (XML-based) =====================
app.get("/api/wordcount/agency/:slug", async (req, res) => {
  const slug = req.params.slug;
  const agencies = metadataCache.get("agenciesMetadata") || [];
  const agency = agencies.find(a =>
    a.slug === slug || a.name.toLowerCase().replace(/\s+/g, "-") === slug
  );
  if (!agency) return res.status(404).json({ error: "Agency not found" });

  const refs = agency.cfr_references || [];
  if (!refs.length) return res.json({ agency: agency.name, total: 0, breakdowns: [] });

  let totalWords = 0;
  const breakdowns = [];

  try {
    for (const ref of refs) {
      const title = ref.title;
      const chapter = ref.chapter || "N/A";
      const cacheKey = `agency-words-${slug}-title-${title}-chapter-${chapter}`;
      let words = wordCountCache.get(cacheKey);

      if (words !== undefined) {
        console.log(`✅ Cache hit: ${cacheKey}`);
      } else {
        const titles = metadataCache.get("titlesMetadata") || [];
        const meta = titles.find(t => t.number === title || t.number.toString() === title.toString());
        const issueDate = meta?.latest_issue_date;
        if (!issueDate) continue;

        const xmlUrl = `${VERSIONER}/full/${issueDate}/title-${title}.xml`;
        words = await streamAndCountWords(xmlUrl);
        wordCountCache.set(cacheKey, words);
      }

      breakdowns.push({ title, chapter, wordCount: words });
      totalWords += words;
    }

    res.json({ agency: agency.name, total: totalWords, breakdowns });
  } catch (e) {
    console.error("🚨 Agency XML error:", e.message);
    res.status(500).json({ error: "Failed to process agency content" });
  }
});

// ===================== Stream XML Word Count Utility =====================
async function streamAndCountWords(url) {
  try {
    const response = await axios({ method: "GET", url, responseType: "stream", timeout: 60000 });
    let wordCount = 0;
    const parser = sax.createStream(true);

    parser.on("text", text => {
      const words = text.trim().split(/\s+/).filter(Boolean);
      wordCount += words.length;
    });

    return new Promise((resolve, reject) => {
      parser.on("end", () => resolve(wordCount));
      parser.on("error", reject);
      response.data.pipe(parser);
    });
  } catch (e) {
    console.error("🚨 XML Stream error:", e.message);
    return 0;
  }
}

// ===================== Search =====================
app.get("/api/search", async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/api/search/v1/results`, { params: req.query });
    res.json(response.data);
  } catch (e) {
    console.error("🚨 Search error:", e.message);
    res.status(500).json({ error: "Search failed" });
  }
});

// ===================== Search Count =====================
app.get("/api/search/count", async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/api/search/v1/count`, { params: req.query });
    res.json(response.data);
  } catch (e) {
    console.error("🚨 Search Count error:", e.message);
    res.status(500).json({ error: "Search count failed" });
  }
});

// ===================== Suggestions =====================
app.get("/api/search/suggestions", async (req, res) => {
  const query = (req.query.query || "").toLowerCase().trim();
  if (!query) return res.json({ suggestions: [] });

  try {
    const cacheKey = `suggestions-${query}`;
    if (suggestionCache.has(cacheKey)) return res.json({ suggestions: suggestionCache.get(cacheKey) });

    const titles = metadataCache.get("titlesMetadata") || [];
    const agencies = metadataCache.get("agenciesMetadata") || [];
    const suggestions = [
      ...titles.filter(t => t.name.toLowerCase().includes(query)).map(t => `Title ${t.number}: ${t.name}`),
      ...agencies.filter(a => a.name.toLowerCase().includes(query)).map(a => a.name)
    ];

    const unique = [...new Set(suggestions)].slice(0, 10);
    suggestionCache.set(cacheKey, unique);
    res.json({ suggestions: unique });
  } catch (e) {
    console.error("🚨 Suggestions error:", e.message);
    res.status(500).json({ suggestions: [] });
  }
});

// ===================== Metadata Preload =====================
(async function preloadMetadata() {
  try {
    const titlesRes = await axios.get(`${VERSIONER}/titles.json`);
    metadataCache.set("titlesMetadata", titlesRes.data.titles.map(t => ({
      number: t.number,
      name: t.name,
      latest_issue_date: t.latest_issue_date,
      latest_amended_on: t.latest_amended_on,
      up_to_date_as_of: t.up_to_date_as_of
    })));

    const agenciesRes = await axios.get(`${ADMIN}/agencies.json`);
    const agencies = agenciesRes.data.agencies || agenciesRes.data;
    metadataCache.set("agenciesMetadata", agencies);

    console.log("✅ Metadata preload complete");
  } catch (e) {
    console.error("🚨 Metadata preload error:", e.message);
  }
})();

// ===================== Start Server =====================
app.listen(PORT, () => {
  console.log(`🚀 eCFR Analyzer running on port ${PORT}`);
});
