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

// ========== Titles ==========

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
    res.status(500).json({ error: "Failed to fetch titles" });
  }
});

// ========== Agencies ==========

app.get("/api/agencies", async (req, res) => {
  try {
    const response = await axios.get(`${ADMIN}/agencies.json`);
    const agencies = response.data.agencies || response.data;
    metadataCache.set("agenciesMetadata", agencies);
    res.json({ agencies });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch agencies" });
  }
});

// ========== Word Count by Title ==========

app.get("/api/wordcount/:titleNumber", async (req, res) => {
  const titleNumber = req.params.titleNumber;
  const cacheKey = `wordCount-${titleNumber}`;
  const cached = wordCountCache.get(cacheKey);
  if (cached !== undefined) return res.json({ title: titleNumber, wordCount: cached });

  try {
    const titles = metadataCache.get("titlesMetadata") || [];
    const meta = titles.find(t => t.number.toString() === titleNumber.toString());
    const issueDate = meta?.latest_issue_date;
    if (!issueDate) return res.json({ title: titleNumber, wordCount: 0 });

    const xmlUrl = `${VERSIONER}/full/${issueDate}/title-${titleNumber}.xml`;
    const wordCount = await streamAndCountWords(xmlUrl);
    wordCountCache.set(cacheKey, wordCount);
    res.json({ title: titleNumber, wordCount });
  } catch (e) {
    res.status(500).json({ error: "Failed to count words" });
  }
});

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
        if (buffer.length) wordCount++;
        resolve(wordCount);
      });
      response.data.on("error", reject);
    });
  } catch {
    return 0;
  }
}

// ===================== Word Count by Agency (XML-based scoped version) =====================

app.get("/api/wordcount/agency/:slug", async (req, res) => {
  const slug = req.params.slug;
  const agencies = metadataCache.get("agenciesMetadata") || [];
  const agency = agencies.find(
    (a) => a.slug === slug || a.name.toLowerCase().replace(/\s+/g, "-") === slug
  );
  if (!agency) return res.status(404).json({ error: "Agency not found" });

  const refs = agency.cfr_references || [];
  if (!refs.length) return res.json({ agency: agency.name, total: 0, breakdowns: [] });

  let totalWords = 0;
  const breakdowns = [];

  for (const ref of refs) {
    const title = ref.title;
    const chapter = ref.chapter;
    const cacheKey = `agency-scope-${slug}-title-${title}-chapter-${chapter}`;
    let cachedCount = wordCountCache.get(cacheKey);

    if (cachedCount !== undefined) {
      breakdowns.push({ title, chapter, wordCount: cachedCount });
      totalWords += cachedCount;
      continue;
    }

    try {
      const titles = metadataCache.get("titlesMetadata") || [];
      const meta = titles.find((t) => t.number.toString() === title.toString());
      const issueDate = meta?.latest_issue_date;
      if (!issueDate) continue;

      const xmlUrl = `${VERSIONER}/full/${issueDate}/title-${title}.xml`;
      const response = await axios({ method: "GET", url: xmlUrl, responseType: "stream", timeout: 60000 });

      const parser = sax.createStream(true);

      let insideChapter = false;
      let currentText = "";
      let currentTag = "";
      let captureText = false;
      const hierarchyStack = [];

      parser.on("opentag", (node) => {
        const { name, attributes } = node;

        // Track hierarchy
        if (name.startsWith("DIV") && attributes.TYPE && attributes.N) {
          hierarchyStack.push({ type: attributes.TYPE.toLowerCase(), number: attributes.N });

          if (attributes.TYPE.toLowerCase() === "chapter" && attributes.N === chapter) {
            insideChapter = true;
          }
        }

        if (insideChapter && ["P", "FP", "HD", "HEAD", "GPOTABLE"].includes(name)) {
          captureText = true;
          currentTag = name;
        }
      });

      parser.on("text", (text) => {
        if (captureText && insideChapter) {
          currentText += text.trim() + " ";
        }
      });

      parser.on("closetag", (tag) => {
        if (captureText && tag === currentTag) {
          captureText = false;
          currentTag = "";
        }

        if (tag.startsWith("DIV") && hierarchyStack.length > 0) {
          const popped = hierarchyStack.pop();
          if (popped.type === "chapter" && popped.number === chapter) {
            insideChapter = false;
          }
        }
      });

      parser.on("end", () => {
        const scopedWords = currentText.trim().split(/\s+/).filter(Boolean).length;
        wordCountCache.set(cacheKey, scopedWords);
        breakdowns.push({ title, chapter, wordCount: scopedWords });
        totalWords += scopedWords;
        if (ref === refs[refs.length - 1]) {
          res.json({ agency: agency.name, total: totalWords, breakdowns });
        }
      });

      parser.on("error", (err) => {
        console.error(`🚨 XML parse error for agency ${agency.name}:`, err.message);
        res.status(500).json({ error: "XML parse error" });
      });

      response.data.pipe(parser);
    } catch (e) {
      console.error(`🚨 Error processing agency ${agency.name}:`, e.message);
    }
  }
});

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
    console.log("✅ Metadata preload complete.");
  } catch (e) {
    console.error("🚨 Metadata preload failed:", e.message);
  }
})();

// ===================== Start Server =====================
app.listen(PORT, () => {
  console.log(`🚀 eCFR Analyzer server running on port ${PORT}`);
});



// ===================== TEST: Full Agency Chapter Structure Walker =====================
app.get("/api/test-agency-chapter-structure/:title/:chapter", async (req, res) => {
  const titleNumber = req.params.title;
  const chapterId = req.params.chapter;
  const results = [];
  const visitedNodes = new Set();
  const axios = require("axios");

  try {
    const titles = metadataCache.get("titlesMetadata") || [];
    const meta = titles.find(t => t.number.toString() === titleNumber.toString());
    const issueDate = meta?.latest_issue_date;
    if (!issueDate) return res.status(400).json({ error: "Missing issue date for title" });

    const structureUrl = `${VERSIONER}/structure/${issueDate}/title-${titleNumber}.json`;
    const structure = (await axios.get(structureUrl)).data;

    // Recursive walk function
    function walk(node, path = []) {
      if (!node || visitedNodes.has(node.identifier)) return;
      visitedNodes.add(node.identifier);

      const updatedPath = [...path];
      if (node.type === "chapter") updatedPath.push(`Chapter ${node.identifier}`);
      else if (node.type === "subchapter") updatedPath.push(`Subchapter ${node.identifier}`);
      else if (node.type === "part") updatedPath.push(`Part ${node.identifier}`);
      else if (node.type === "subpart") updatedPath.push(`Subpart ${node.identifier}`);
      else if (node.type === "section") {
        updatedPath.push(`Section ${node.identifier}`);
        results.push({ path: updatedPath.join(" → "), type: "section" });
        return;
      }

      if (["chapter", "subchapter", "part", "subpart"].includes(node.type)) {
        results.push({ path: updatedPath.join(" → "), type: node.type });
      }

      if (node.children && Array.isArray(node.children)) {
        node.children.forEach(child => walk(child, updatedPath));
      }
    }

    // Start from matching chapter root
    const chapterNode = structure.children?.find(child =>
      child.type === "chapter" && child.identifier === chapterId
    );
    if (!chapterNode) return res.status(404).json({ error: `Chapter ${chapterId} not found in Title ${titleNumber}` });

    walk(chapterNode);

    return res.json({
      title: `Title ${titleNumber}`,
      chapter: chapterId,
      nodeCount: results.length,
      structure: results
    });

  } catch (e) {
    console.error("🚨 Chapter Structure Test Error:", e.message);
    return res.status(500).json({ error: "Structure parsing error" });
  }
});


// ===================== DEBUG STRUCTURE TREE: /api/debug-structure/:titleNumber =====================
app.get("/api/debug-structure/:titleNumber", async (req, res) => {
  const titleNumber = req.params.titleNumber;
  const titles = metadataCache.get("titlesMetadata") || [];
  const meta = titles.find(t => t.number.toString() === titleNumber.toString());
  if (!meta || !meta.latest_issue_date) {
    return res.status(400).json({ error: "Invalid or missing title metadata" });
  }

  const structureUrl = `${VERSIONER}/structure/${meta.latest_issue_date}/title-${titleNumber}.json`;

  try {
    const response = await axios.get(structureUrl);
    const root = response.data;

    const nodes = [];

    function traverse(node, path = []) {
      const currentPath = [...path, `${node.type}(${node.identifier || "?"})`];
      nodes.push({
        type: node.type,
        identifier: node.identifier || null,
        path: currentPath.join(" → ")
      });

      if (node.children && Array.isArray(node.children)) {
        node.children.forEach(child => traverse(child, currentPath));
      }
    }

    traverse(root);

    res.json({
      title: `Title ${titleNumber}`,
      totalNodes: nodes.length,
      nodes
    });
  } catch (err) {
    console.error("🚨 DEBUG STRUCTURE error:", err.message);
    res.status(500).json({ error: "Failed to fetch or parse structure JSON" });
  }
});

