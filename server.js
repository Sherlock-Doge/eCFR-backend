// eCFR Analyzer Backend – FINAL FIXED VERSION ✅ Puppeteer-Core + Chromium.path
const express = require("express");
const axios = require("axios");
const { JSDOM } = require("jsdom");
const NodeCache = require("node-cache");
const puppeteer = require("puppeteer-core");
const chromium = require("chromium");

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
      console.log("📥 Fetching eCFR Titles...");
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
    console.log("📥 Fetching agency data...");
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
  let cachedWordCount = wordCountCache.get(cacheKey);
  if (cachedWordCount !== undefined) {
    return res.json({ title: titleNumber, wordCount: cachedWordCount });
  }

  try {
    const titles = metadataCache.get("titlesMetadata") || [];
    const title = titles.find(t => t.number.toString() === titleNumber);
    if (!title || title.name === "Reserved") return res.json({ title: titleNumber, wordCount: 0 });

    const xmlUrl = `${VERSIONER}/full/${title.latest_issue_date}/title-${titleNumber}.xml`;
    const count = await streamAndCountWords(xmlUrl);
    wordCountCache.set(cacheKey, count);
    res.json({ title: titleNumber, wordCount: count });
  } catch (e) {
    console.error("🚨 Title Word Count Error:", e.message);
    res.status(500).json({ error: "Failed to count words" });
  }
});

// ===================== Stream XML Parser =====================
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
  } catch (e) {
    console.error("🚨 Stream error:", e.message);
    return 0;
  }
}

// ===================== Word Count by Agency (Chromium.path based) =====================
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
    const browser = await puppeteer.launch({
      headless: "new",
      executablePath: chromium.path,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

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
        if (!issueDate) {
          console.warn(`⚠️ No issue date for Title ${title}`);
          continue;
        }

        const structureUrl = `${VERSIONER}/structure/${issueDate}/title-${title}.json`;
        const structure = (await axios.get(structureUrl)).data;
        const sectionUrls = [];

        function recurse(node, path = []) {
          const updatedPath = [...path];
          if (node.type === "chapter") updatedPath.push(`chapter-${node.identifier}`);
          if (node.type === "subchapter") updatedPath.push(`subchapter-${node.identifier}`);
          if (node.type === "part") updatedPath.push(`part-${node.identifier}`);
          if (node.type === "subpart") updatedPath.push(`subpart-${node.identifier}`);
          if (node.type === "section") {
            updatedPath.push(`section-${node.identifier}`);
            const url = `${BASE_URL}/current/title-${title}/${updatedPath.join("/")}`;
            sectionUrls.push(url);
          }
          if (node.children) node.children.forEach(child => recurse(child, updatedPath));
        }

        recurse(structure);

        console.log(`🔍 Found ${sectionUrls.length} section URLs for Title ${title}, Chapter ${chapter}`);

        words = 0;
        for (const url of sectionUrls) {
          try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
            const text = await page.evaluate(() => {
              const el =
                document.querySelector(".content-col") ||
                document.querySelector("main") ||
                document.querySelector("#content") ||
                document.querySelector("#primary-content");
              return el ? el.innerText : "";
            });
            const count = text.split(/\s+/).filter(Boolean).length;
            words += count;

            if (!count || text.length < 10) console.warn(`⚠️ Empty content at ${url}`);
            console.log(`📄 ${url} → ${count} words`);
          } catch (err) {
            console.warn(`❌ Failed section: ${url} → ${err.message}`);
          }
        }

        wordCountCache.set(cacheKey, words);
      }

      breakdowns.push({ title, chapter, wordCount: words });
      totalWords += words;
    }

    await browser.close();
    res.json({ agency: agency.name, total: totalWords, breakdowns });
  } catch (e) {
    console.error("🚨 Agency Puppeteer error:", e.message);
    res.status(500).json({ error: "Failed to scrape agency content" });
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



// ===================== TEMP TEST: /api/test-puppeteer =====================
app.get("/api/test-puppeteer", async (req, res) => {
  const puppeteer = require("puppeteer-core");
  const chromium = require("chromium");

  try {
    const browser = await puppeteer.launch({
      headless: "new",
      executablePath: chromium.path,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    // ✅ Spoof user-agent + headers to trick ECFR anti-bot defenses
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9"
    });

    const testUrl = "https://www.ecfr.gov/current/title-1/chapter-III/part-301/section-301.1";
    await page.goto(testUrl, { waitUntil: "networkidle2", timeout: 60000 });

    const text = await page.evaluate(() => {
      const selectors = [
        ".section",               // ✅ most consistent ECFR content block
        ".content-col",
        "main",
        "#content",
        "#primary-content"
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim().length > 20) {
          return el.innerText.trim();
        }
      }
      // Fallback
      return document.body?.innerText?.trim() || "(No content found)";
    });

    const wordCount = text.split(/\s+/).filter(Boolean).length;

    await browser.close();

    res.json({
      url: testUrl,
      preview: text.slice(0, 300),
      wordCount
    });
  } catch (e) {
    console.error("🚨 /api/test-puppeteer error:", e.message);
    res.status(500).json({ error: e.message });
  }
});



// ===================== TEMP TEST: /api/test-titlexml-dive/:titleNumber =====================
app.get("/api/test-titlexml-dive/:titleNumber", async (req, res) => {
  const titleNumber = req.params.titleNumber;
  const axios = require("axios");
  const sax = require("sax");

  const VERSIONER = "https://www.ecfr.gov/api/versioner/v1";
  const tagSet = new Set();
  const breakdowns = [];

  try {
    const titles = metadataCache.get("titlesMetadata") || [];
    const meta = titles.find(t => t.number.toString() === titleNumber.toString());
    const issueDate = meta?.latest_issue_date;
    if (!issueDate) return res.status(400).json({ error: "Missing issue date for title" });

    const xmlUrl = `${VERSIONER}/full/${issueDate}/title-${titleNumber}.xml`;
    const response = await axios({ method: "GET", url: xmlUrl, responseType: "stream", timeout: 60000 });

    const parser = sax.createStream(true);

    let currentPart = "";
    let currentSubpart = "";
    let currentText = "";
    let currentTag = "";
    let captureText = false;

    parser.on("opentag", node => {
      tagSet.add(node.name);

      // Update hierarchy context
      if (node.name === "PART") currentPart = node.attributes?.N || "";
      if (node.name === "SUBPART") currentSubpart = node.attributes?.N || "";

      // Capture actual paragraph-like content
      if (["P", "FP", "HD", "GPOTABLE"].includes(node.name)) {
        captureText = true;
        currentTag = node.name;
      }
    });

    parser.on("text", text => {
      if (captureText) currentText += text.trim() + " ";
    });

    parser.on("closetag", tagName => {
      if (captureText && tagName === currentTag) {
        const cleanText = currentText.trim();
        const wordCount = cleanText.split(/\s+/).filter(Boolean).length;

        if (wordCount > 0) {
          breakdowns.push({
            part: currentPart || null,
            subpart: currentSubpart || null,
            wordCount,
            preview: cleanText.slice(0, 150)
          });
        }

        currentText = "";
        captureText = false;
      }
    });

    parser.on("error", err => {
      console.error("🚨 XML parse error:", err.message);
      res.status(500).json({ error: "XML parse error" });
    });

    parser.on("end", () => {
      res.json({
        title: `Title ${titleNumber}`,
        uniqueTags: Array.from(tagSet).sort(),
        breakdowns
      });
    });

    response.data.pipe(parser);
  } catch (e) {
    console.error("🚨 /api/test-titlexml-dive error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===================== FIXED TEST: Full Section Content Extraction =====================
app.get("/api/test-titlexml-fullsection/:titleNumber/:sectionNumber", async (req, res) => {
  const titleNumber = req.params.titleNumber;
  const targetSection = req.params.sectionNumber; // e.g., "301.1"
  const axios = require("axios");
  const sax = require("sax");

  const VERSIONER = "https://www.ecfr.gov/api/versioner/v1";

  try {
    const titles = metadataCache.get("titlesMetadata") || [];
    const meta = titles.find(t => t.number.toString() === titleNumber.toString());
    const issueDate = meta?.latest_issue_date;
    if (!issueDate) return res.status(400).json({ error: "Missing issue date for title" });

    const xmlUrl = `${VERSIONER}/full/${issueDate}/title-${titleNumber}.xml`;
    const response = await axios({ method: "GET", url: xmlUrl, responseType: "stream", timeout: 60000 });

    const parser = sax.createStream(true);
    let hierarchyStack = [];
    let captureText = false;
    let currentText = "";
    let foundSection = false;

    parser.on("opentag", node => {
      const { name, attributes } = node;

      if (name.startsWith("DIV") && attributes.TYPE && attributes.N) {
        hierarchyStack.push({ type: attributes.TYPE, number: attributes.N });
        if (attributes.TYPE.toLowerCase() === "section" && attributes.N === targetSection) {
          foundSection = true;
        }
      }

      if (foundSection && ["P", "FP", "HD", "HEAD", "GPOTABLE"].includes(name)) {
        captureText = true;
      }
    });

    parser.on("text", text => {
      if (captureText && foundSection) {
        currentText += text.trim() + " ";
      }
    });

    parser.on("closetag", tagName => {
      if (captureText && ["P", "FP", "HD", "HEAD", "GPOTABLE"].includes(tagName)) {
        captureText = false;
      }

      if (tagName.startsWith("DIV") && hierarchyStack.length > 0) {
        const popped = hierarchyStack.pop();
        if (popped.type.toLowerCase() === "section" && popped.number === targetSection) {
          foundSection = false;
        }
      }
    });

    parser.on("end", () => {
      const cleanText = currentText.trim();
      res.json({
        title: `Title ${titleNumber}`,
        section: targetSection,
        wordCount: cleanText.split(/\s+/).filter(Boolean).length,
        contentPreview: cleanText.slice(0, 1000)
      });
    });

    parser.on("error", err => {
      console.error("🚨 XML parse error:", err.message);
      res.status(500).json({ error: "XML parse error" });
    });

    response.data.pipe(parser);
  } catch (e) {
    console.error("🚨 XML hierarchy debug error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

