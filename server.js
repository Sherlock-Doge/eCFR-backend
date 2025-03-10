// ✅ eCFR Analyzer – FINAL Backend Server.js (Simplified, Clean, Fully Functional)

const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const sax = require("sax");

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

// ✅ Titles API
app.get("/api/titles", async (req, res) => {
  try {
    let cached = metadataCache.get("titlesMetadata");
    if (!cached) {
      console.log("📥 Fetching eCFR Titles...");
      const response = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
      cached = response.data.titles.map(t => ({
        number: t.number,
        name: t.name,
        latest_issue_date: t.latest_issue_date,
        latest_amended_on: t.latest_amended_on,
        up_to_date_as_of: t.up_to_date_as_of
      }));
      metadataCache.set("titlesMetadata", cached);
    } else {
      console.log("✅ Titles loaded from cache");
    }
    res.json({ titles: cached });
  } catch (e) {
    console.error("🚨 Titles error:", e.message);
    res.status(500).json({ error: "Failed to fetch titles" });
  }
});

// ✅ Agencies API
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

// ✅ Word Count by Title
app.get("/api/wordcount/:titleNumber", async (req, res) => {
  const titleNumber = req.params.titleNumber;
  let cached = wordCountCache.get(`wordCount-${titleNumber}`);
  if (cached !== undefined) {
    console.log(`✅ Cached word count hit for Title ${titleNumber}`);
    return res.json({ title: titleNumber, wordCount: cached });
  }

  try {
    console.log(`📥 Calculating word count for Title ${titleNumber}`);
    const titles = metadataCache.get("titlesMetadata") || [];
    const titleMeta = titles.find(t => t.number.toString() === titleNumber);
    if (!titleMeta || titleMeta.name === "Reserved") return res.json({ title: titleNumber, wordCount: 0 });

    const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${titleMeta.latest_issue_date}/title-${titleNumber}.xml`;
    const count = await streamAndCountWords(xmlUrl);
    if (count === null) return res.status(500).json({ error: "Failed to parse XML" });

    wordCountCache.set(`wordCount-${titleNumber}`, count);
    res.json({ title: titleNumber, wordCount: count });
  } catch (e) {
    console.error("🚨 Title Word Count Error:", e.message);
    res.status(500).json({ error: "Failed to calculate word count" });
  }
});

// ✅ Word Count by Agency
app.get("/api/wordcount/agency/:slug", async (req, res) => {
  const slug = req.params.slug;
  const agencies = metadataCache.get("agenciesMetadata") || [];
  const titles = metadataCache.get("titlesMetadata") || [];
  const agency = agencies.find(a =>
    a.slug === slug || a.name.toLowerCase().replace(/\s+/g, "-") === slug
  );
  if (!agency) return res.status(404).json({ error: "Agency not found" });

  const refs = agency.cfr_references || [];
  if (!refs.length) return res.json({ agency: agency.name, wordCount: 0 });

  let total = 0;
  try {
    const titleMap = {};
    refs.forEach(r => {
      const id = r.part || r.chapter;
      if (!titleMap[r.title]) titleMap[r.title] = [];
      if (id && !titleMap[r.title].includes(id)) titleMap[r.title].push(id);
    });

    for (const [titleNumber, targets] of Object.entries(titleMap)) {
      const titleMeta = titles.find(t => t.number == titleNumber);
      if (!titleMeta || titleMeta.name === "Reserved") continue;

      const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${titleMeta.latest_issue_date}/title-${titleNumber}.xml`;
      const cacheKey = `agency-${slug}-title-${titleNumber}`;
      const cached = wordCountCache.get(cacheKey);
      if (cached !== undefined) {
        console.log(`✅ Using cached count for ${agency.name} Title ${titleNumber}`);
        total += cached;
        continue;
      }

      console.log(`📦 Parsing Title ${titleNumber} for ${agency.name} → [${targets.join(", ")}]`);
      const count = await countAgencyRelevantWords(xmlUrl, targets);
      wordCountCache.set(cacheKey, count);
      total += count;
    }

    res.json({ agency: agency.name, wordCount: total });
  } catch (e) {
    console.error("🚨 Agency Word Count Error:", e.message);
    res.status(500).json({ error: "Failed to calculate agency word count" });
  }
});

// ✅ Streamed Word Count (Full Title)
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
        if (buffer.trim()) wordCount++;
        resolve(wordCount);
      });
      response.data.on("error", reject);
    });
  } catch (e) {
    console.error("🚨 Stream error:", e.message);
    return null;
  }
}

// ✅ Filtered Word Count for Agency Matching
async function countAgencyRelevantWords(url, targets = []) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await axios({ method: "GET", url, responseType: "stream" });
      const parser = sax.createStream(true);
      let wordCount = 0, capture = false;

      parser.on("opentag", node => {
        if ((node.name === "CHAPTER" || node.name === "PART") && node.attributes?.N) {
          const id = node.attributes.N.trim();
          capture = targets.includes(id);
          console.log(`🔍 OPEN ${node.name} N="${id}" → match=${capture}`);
        }
      });

      parser.on("text", text => {
        if (capture) {
          const words = text.trim().split(/\s+/);
          wordCount += words.filter(w => w).length;
        }
      });

      parser.on("closetag", tag => {
        if ((tag === "CHAPTER" || tag === "PART") && capture) {
          capture = false;
        }
      });

      parser.on("end", () => {
        console.log(`✅ Final stream word count: ${wordCount}`);
        resolve(wordCount);
      });

      parser.on("error", err => {
        console.error("🚨 SAX error:", err.message);
        reject(err);
      });

      response.data.pipe(parser);
    } catch (e) {
      console.error("🚨 Filtered stream error:", e.message);
      reject(e);
    }
  });
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
    console.error("🚨 Suggestions error:", e.message);
    res.status(500).json({ suggestions: [] });
  }
});

// ✅ Metadata Preload
(async function preloadMetadata() {
  try {
    const titlesRes = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
    metadataCache.set("titlesMetadata", titlesRes.data.titles);

    const agenciesRes = await axios.get(`${BASE_URL}/api/admin/v1/agencies.json`);
    const agencies = agenciesRes.data.agencies || agenciesRes.data;
    metadataCache.set("agenciesMetadata", agencies);

    console.log("✅ Metadata preload complete.");
  } catch (e) {
    console.error("🚨 Metadata preload error:", e.message);
  }
})();

// ✅ Server Start
app.listen(PORT, () => {
  console.log(`🚀 eCFR Analyzer server running on port ${PORT}`);
});
