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

// ✅ Titles Route
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

// ✅ Agencies Route
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

// ✅ Word Count (Full Title)
app.get("/api/wordcount/:titleNumber", async (req, res) => {
  const titleNumber = req.params.titleNumber;
  let cached = wordCountCache.get(`wordCount-${titleNumber}`);
  if (cached !== undefined) return res.json({ title: titleNumber, wordCount: cached });

  try {
    const titles = metadataCache.get("titlesMetadata");
    const title = titles.find(t => t.number == titleNumber);
    if (!title || title.name === "Reserved") return res.json({ title: titleNumber, wordCount: 0 });

    const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${title.latest_issue_date}/title-${titleNumber}.xml`;
    const count = await streamAndCountWords(xmlUrl);
    wordCountCache.set(`wordCount-${titleNumber}`, count);
    res.json({ title: titleNumber, wordCount: count });
  } catch (e) {
    console.error("🚨 Title Word Count Error:", e.message);
    res.status(500).json({ error: "Failed to calculate word count" });
  }
});

// ✅ Word Count (Agency Granular)
app.get("/api/wordcount/agency/:slug", async (req, res) => {
  const slug = req.params.slug;
  const agencies = metadataCache.get("agenciesMetadata") || [];
  const titles = metadataCache.get("titlesMetadata") || [];
  const agency = agencies.find(a => a.slug === slug || a.name.toLowerCase().replace(/\s+/g, "-") === slug);
  if (!agency) return res.status(404).json({ error: "Agency not found" });

  const refs = agency.cfr_references || [];
  if (!refs.length) return res.json({ agency: agency.name, wordCount: 0 });

  try {
    let totalWords = 0;
    const grouped = {};

    refs.forEach(ref => {
      if (!grouped[ref.title]) grouped[ref.title] = new Set();
      if (ref.chapter) grouped[ref.title].add(`CHAPTER-${ref.chapter}`);
      if (ref.part) grouped[ref.title].add(`PART-${ref.part}`);
    });

    for (const [titleNum, targetSet] of Object.entries(grouped)) {
      const titleMeta = titles.find(t => t.number == titleNum);
      if (!titleMeta || titleMeta.name === "Reserved") continue;

      const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${titleMeta.latest_issue_date}/title-${titleNum}.xml`;
      const structureUrl = `${BASE_URL}/api/versioner/v1/structure/${titleMeta.latest_issue_date}/title-${titleNum}.json`;

      const cacheKey = `agency-${slug}-title-${titleNum}-granular`;
      const cached = wordCountCache.get(cacheKey);
      if (cached !== undefined) {
        totalWords += cached;
        continue;
      }

      const structure = await axios.get(structureUrl).then(r => r.data).catch(() => null);
      const relevantIds = extractRelevantStructureIds(structure, targetSet);
      const words = await countFilteredWordsViaSAX(xmlUrl, relevantIds);
      wordCountCache.set(cacheKey, words);
      totalWords += words;
    }

    res.json({ agency: agency.name, wordCount: totalWords });
  } catch (e) {
    console.error("🚨 Agency Word Count Error:", e.message);
    res.status(500).json({ error: "Failed to calculate agency word count" });
  }
});

// ✅ Word Counter (Full Title)
async function streamAndCountWords(url) {
  try {
    const response = await axios({ method: "GET", url, responseType: "stream", timeout: 60000 });
    return new Promise((resolve, reject) => {
      let buffer = "", count = 0;
      response.data.on("data", chunk => {
        buffer += chunk.toString();
        const words = buffer.split(/\s+/);
        count += words.length - 1;
        buffer = words.pop();
      });
      response.data.on("end", () => {
        if (buffer.trim()) count++;
        resolve(count);
      });
      response.data.on("error", reject);
    });
  } catch (e) {
    console.error("🚨 Stream error:", e.message);
    return 0;
  }
}

// ✅ Word Counter (Filtered by Structure ID via SAX)
async function countFilteredWordsViaSAX(xmlUrl, relevantIds = []) {
  return new Promise(async (resolve, reject) => {
    try {
      const response = await axios({ method: "GET", url: xmlUrl, responseType: "stream", timeout: 60000 });
      const parser = sax.createStream(true);
      let wordCount = 0, capture = false;

      parser.on("opentag", node => {
        const id = node.attributes?.identifier;
        if (id && relevantIds.includes(id)) capture = true;
      });

      parser.on("text", text => {
        if (capture) {
          const words = text.trim().split(/\s+/);
          wordCount += words.filter(Boolean).length;
        }
      });

      parser.on("closetag", name => {
        capture = false;
      });

      parser.on("end", () => resolve(wordCount));
      parser.on("error", err => {
        console.error("🚨 SAX Error:", err.message);
        reject(err);
      });

      response.data.pipe(parser);
    } catch (e) {
      console.error("🚨 Filtered SAX Stream Error:", e.message);
      reject(e);
    }
  });
}

// ✅ Structure ID Extractor
function extractRelevantStructureIds(structureJson, targets = new Set()) {
  const relevant = [];

  function traverse(node) {
    if (!node) return;
    const id = node.identifier;
    if (id && [...targets].some(t => id.includes(t))) relevant.push(id);
    if (node.children && node.children.length > 0) {
      node.children.forEach(child => traverse(child));
    }
  }

  traverse(structureJson);
  return relevant;
}

// ✅ Search
app.get("/api/search", async (req, res) => {
  try {
    const r = await axios.get(`${BASE_URL}/api/search/v1/results`, { params: req.query });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: "Search failed" });
  }
});

// ✅ Suggestions
app.get("/api/search/suggestions", async (req, res) => {
  const query = (req.query.query || "").toLowerCase().trim();
  if (!query) return res.json({ suggestions: [] });
  try {
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

    suggestionCache.set(cacheKey, suggestions.slice(0, 10));
    res.json({ suggestions: suggestions.slice(0, 10) });
  } catch (e) {
    res.status(500).json({ suggestions: [] });
  }
});

// ✅ Relational Map (Static Fallback)
const staticMap = {
  "Department of Agriculture": [2, 5, 7, 48],
  "Department of Homeland Security": [6],
  "Department of Defense": [32],
  "Department of Transportation": [49],
  "Department of Energy": [10],
  "Environmental Protection Agency": [40]
};

app.get("/api/agency-title-map", (req, res) => {
  res.json({ map: metadataCache.get("agencyTitleMap") || staticMap });
});

// ✅ Metadata Preload
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

    const map = {};
    agencies.forEach(a => {
      a.titles?.forEach(t => {
        if (!map[a.name]) map[a.name] = [];
        if (!map[a.name].includes(t.title_number)) {
          map[a.name].push(t.title_number);
        }
      });
    });
    metadataCache.set("agencyTitleMap", map);

    console.log("✅ Metadata Preload Complete");
  } catch (e) {
    console.error("🚨 Metadata preload failed:", e.message);
  }
})();

// ✅ Server Boot
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
