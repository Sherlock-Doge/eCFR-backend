// eCFR Analyzer Backend – FINAL Version: Accurate Agency Word Count using Structure JSON Hierarchy
const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const { JSDOM } = require("jsdom");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// Caches
const wordCountCache = new NodeCache({ stdTTL: 5184000 });
const metadataCache = new NodeCache({ stdTTL: 86400 });
const suggestionCache = new NodeCache({ stdTTL: 43200 });

// Middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// Type → Path prefix mapping
const TYPE_PREFIX = {
  title: "title-",
  subtitle: "subtitle-",
  chapter: "chapter-",
  subchapter: "subchapter-",
  part: "part-",
  subpart: "subpart-",
  section: "section-",
  appendix: "appendix-"
};

// Titles Endpoint
app.get("/api/titles", async (req, res) => {
  try {
    let cachedTitles = metadataCache.get("titlesMetadata");
    if (!cachedTitles) {
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
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch titles" });
  }
});

// Agencies Endpoint
app.get("/api/agencies", async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/api/admin/v1/agencies.json`);
    const agencies = response.data.agencies || response.data;
    metadataCache.set("agenciesMetadata", agencies);
    res.json({ agencies });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch agencies" });
  }
});

// Word Count by Title (XML Streaming)
app.get("/api/wordcount/:titleNumber", async (req, res) => {
  const titleNumber = req.params.titleNumber;
  const cacheKey = `wordcount-title-${titleNumber}`;
  const cached = wordCountCache.get(cacheKey);
  if (cached !== undefined) return res.json({ title: titleNumber, wordCount: cached });

  try {
    const titles = metadataCache.get("titlesMetadata") || [];
    const title = titles.find(t => t.number.toString() === titleNumber);
    if (!title) return res.status(404).json({ error: "Title not found" });

    const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${title.latest_issue_date}/title-${titleNumber}.xml`;
    const wordCount = await streamAndCountWords(xmlUrl);
    wordCountCache.set(cacheKey, wordCount);
    res.json({ title: titleNumber, wordCount });
  } catch (err) {
    res.status(500).json({ error: "Failed to count title words" });
  }
});

// Word Count by Agency using Structure JSON
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
  let breakdowns = [];

  try {
    for (const ref of refs) {
      const title = ref.title;
      const chapter = ref.chapter || "N/A";
      const cacheKey = `agency-sectionmap-${slug}-title-${title}-chapter-${chapter}`;
      let sectionUrls = wordCountCache.get(cacheKey);

      // Build section URLs via structure JSON if not cached
      if (!sectionUrls) {
        const titles = metadataCache.get("titlesMetadata") || [];
        const t = titles.find(t => t.number === title);
        if (!t) continue;

        const structureUrl = `${BASE_URL}/api/versioner/v1/structure/${t.latest_issue_date}/title-${title}.json`;
        const structureRes = await axios.get(structureUrl);
        const sectionLinks = [];

        function traverse(node, pathParts = []) {
          const type = node.type;
          const id = node.identifier;
          if (!type || !id) return;

          const prefix = TYPE_PREFIX[type];
          const nextPath = [...pathParts, `${prefix}${id}`];

          if (type === "section") {
            sectionLinks.push(`${BASE_URL}/current/${nextPath.join("/")}`);
          }

          if (node.children && Array.isArray(node.children)) {
            node.children.forEach(child => traverse(child, nextPath));
          }
        }

        traverse(structureRes.data);
        sectionUrls = [...new Set(sectionLinks)];
        wordCountCache.set(cacheKey, sectionUrls);
      }

      // Scrape and count words from each section
      let chapterWords = 0;
      for (const url of sectionUrls) {
        try {
          const response = await axios.get(url, { timeout: 30000 });
          const dom = new JSDOM(response.data);
          const text = dom.window.document.body?.textContent || "";
          const count = text.trim().split(/\s+/).filter(Boolean).length;
          chapterWords += count;
        } catch (err) {
          console.warn(`⚠️ Failed section scrape: ${url}`);
        }
      }

      breakdowns.push({ title, chapter, wordCount: chapterWords });
      totalWords += chapterWords;
    }

    res.json({ agency: agency.name, total: totalWords, breakdowns });
  } catch (err) {
    console.error("🚨 Agency Word Count Error:", err.message);
    res.status(500).json({ error: "Failed to scrape agency content" });
  }
});

// XML Streaming Word Count
async function streamAndCountWords(url) {
  try {
    const response = await axios({ url, method: "GET", responseType: "stream" });
    let buffer = "", count = 0;

    return new Promise((resolve, reject) => {
      response.data.on("data", chunk => {
        buffer += chunk.toString();
        const words = buffer.split(/\s+/);
        count += words.length - 1;
        buffer = words.pop();
      });
      response.data.on("end", () => {
        if (buffer.length > 0) count++;
        resolve(count);
      });
      response.data.on("error", reject);
    });
  } catch (err) {
    return 0;
  }
}

// Search
app.get("/api/search", async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/api/search/v1/results`, { params: req.query });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: "Search failed" });
  }
});

// Search Count
app.get("/api/search/count", async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/api/search/v1/count`, { params: req.query });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: "Search count failed" });
  }
});

// Suggestions
app.get("/api/search/suggestions", async (req, res) => {
  const query = (req.query.query || "").toLowerCase().trim();
  if (!query) return res.json({ suggestions: [] });

  const cacheKey = `suggestions-${query}`;
  if (suggestionCache.has(cacheKey)) return res.json({ suggestions: suggestionCache.get(cacheKey) });

  const titles = metadataCache.get("titlesMetadata") || [];
  const agencies = metadataCache.get("agenciesMetadata") || [];
  const suggestions = [];

  titles.forEach(t => {
    if (t.name.toLowerCase().includes(query)) suggestions.push(`Title ${t.number}: ${t.name}`);
  });
  agencies.forEach(a => {
    if (a.name.toLowerCase().includes(query)) suggestions.push(a.name);
  });

  const result = [...new Set(suggestions)].slice(0, 10);
  suggestionCache.set(cacheKey, result);
  res.json({ suggestions: result });
});

// Metadata Preload
(async function preload() {
  try {
    const titlesRes = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
    const titles = titlesRes.data.titles.map(t => ({
      number: t.number,
      name: t.name,
      latest_issue_date: t.latest_issue_date,
      latest_amended_on: t.latest_amended_on,
      up_to_date_as_of: t.up_to_date_as_of
    }));
    metadataCache.set("titlesMetadata", titles);

    const agenciesRes = await axios.get(`${BASE_URL}/api/admin/v1/agencies.json`);
    const agencies = agenciesRes.data.agencies || agenciesRes.data;
    metadataCache.set("agenciesMetadata", agencies);

    console.log("✅ Metadata preload complete.");
  } catch (err) {
    console.error("🚨 Preload error:", err.message);
  }
})();

// Start server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
