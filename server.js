// eCFR Analyzer Backend – True HTML Scrape Word Count by Agency (Title > Chapter > Section)
const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const { JSDOM } = require("jsdom");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// Caches
const wordCountCache = new NodeCache({ stdTTL: 5184000, checkperiod: 86400 });
const metadataCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });
const suggestionCache = new NodeCache({ stdTTL: 43200, checkperiod: 3600 });

// Middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// Titles Endpoint
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
      console.log("✅ Titles loaded from cache");
    }
    res.json({ titles: cachedTitles });
  } catch (e) {
    console.error("🚨 Titles error:", e.message);
    res.status(500).json({ error: "Failed to fetch titles" });
  }
});

// Agencies Endpoint
app.get("/api/agencies", async (req, res) => {
  try {
    console.log("📥 Fetching agency data...");
    const response = await axios.get(`${BASE_URL}/api/admin/v1/agencies.json`);
    const agencies = response.data.agencies || response.data;
    metadataCache.set("agenciesMetadata", agencies);
    res.json({ agencies });
  } catch (e) {
    console.error("🚨 Agencies error:", e.message);
    res.status(500).json({ error: "Failed to fetch agencies" });
  }
});

// Word Count by Title (XML Stream)
app.get("/api/wordcount/:titleNumber", async (req, res) => {
  const titleNumber = req.params.titleNumber;
  const cacheKey = `wordCount-${titleNumber}`;
  let cachedWordCount = wordCountCache.get(cacheKey);
  if (cachedWordCount !== undefined) {
    console.log(`✅ Cache hit: Title ${titleNumber}`);
    return res.json({ title: titleNumber, wordCount: cachedWordCount });
  }

  try {
    console.log(`📥 Calculating word count for Title ${titleNumber}`);
    let titles = metadataCache.get("titlesMetadata");
    if (!titles) {
      const response = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
      titles = response.data.titles.map(t => ({
        number: t.number,
        name: t.name,
        latest_issue_date: t.latest_issue_date
      }));
      metadataCache.set("titlesMetadata", titles);
    }

    const title = titles.find(t => t.number.toString() === titleNumber);
    if (!title) return res.status(404).json({ error: "Title not found" });
    if (title.name === "Reserved") return res.json({ title: titleNumber, wordCount: 0 });

    const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${title.latest_issue_date}/title-${titleNumber}.xml`;
    const wordCount = await streamAndCountWords(xmlUrl);
    wordCountCache.set(cacheKey, wordCount);
    res.json({ title: titleNumber, wordCount });
  } catch (e) {
    console.error("🚨 Word Count Error:", e.message);
    res.status(500).json({ error: "Failed to calculate word count" });
  }
});

// ✅ NEW TEST ROUTE: Show Section URLs for Agency using Structure JSON
app.get("/api/test-agency-sections/:slug", async (req, res) => {
  const slug = req.params.slug;
  const agencies = metadataCache.get("agenciesMetadata") || [];
  const titles = metadataCache.get("titlesMetadata") || [];
  const agency = agencies.find(a => a.slug === slug || a.name.toLowerCase().replace(/\s+/g, "-") === slug);
  if (!agency) return res.status(404).json({ error: "Agency not found" });

  const refs = agency.cfr_references || [];
  const sectionUrls = [];

  try {
    for (const ref of refs) {
      const titleNum = ref.title;
      const chapterId = ref.chapter || "";

      const titleMeta = titles.find(t => t.number == titleNum);
      if (!titleMeta) continue;

      const structureRes = await axios.get(`${BASE_URL}/api/versioner/v1/structure/${titleMeta.latest_issue_date}/title-${titleNum}.json`);
      const structure = structureRes.data;

      const traverse = (node, path = []) => {
        if (node.type === "section" && node.identifier) {
          const sectionPath = path.concat([node.identifier]);
          const urlPath = sectionPath.join("/").replace(/\/+/g, "/");
          sectionUrls.push(`${BASE_URL}/current/title-${titleNum}/${urlPath}`);
        }
        if (node.children) {
          for (const child of node.children) {
            traverse(child, path.concat([node.identifier || ""]));
          }
        }
      };

      structure.children.forEach(child => {
        if (child.identifier?.includes(`chapter-${chapterId}`) || child.label?.includes(chapterId)) {
          traverse(child, [child.identifier]);
        }
      });
    }

    console.log(`✅ Section URLs for ${agency.name}:`, sectionUrls);
    res.json({ agency: agency.name, sectionUrls });
  } catch (err) {
    console.error("🚨 Structure traversal error:", err.message);
    res.status(500).json({ error: "Traversal failed" });
  }
});

// Generic Stream XML Word Count
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
        console.log(`✅ Final stream word count: ${wordCount}`);
        resolve(wordCount);
      });
      response.data.on("error", reject);
    });
  } catch (e) {
    console.error("🚨 Stream error:", e.message);
    return 0;
  }
}

// Search
app.get("/api/search", async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/api/search/v1/results`, { params: req.query });
    res.json(response.data);
  } catch (e) {
    console.error("🚨 Search error:", e.message);
    res.status(500).json({ error: "Search failed" });
  }
});

// Search Count
app.get("/api/search/count", async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/api/search/v1/count`, { params: req.query });
    res.json(response.data);
  } catch (e) {
    console.error("🚨 Search Count error:", e.message);
    res.status(500).json({ error: "Search count failed" });
  }
});

// Suggestions
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
    console.error("🚨 Suggestion error:", e.message);
    res.status(500).json({ suggestions: [] });
  }
});

// Metadata Preload
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

    console.log("✅ Metadata preload complete.");
  } catch (e) {
    console.error("🚨 Metadata preload failed:", e.message);
  }
})();

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 eCFR Analyzer server running on port ${PORT}`);
});
