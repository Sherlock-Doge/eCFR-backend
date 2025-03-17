const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const sax = require("sax");
const cors = require("cors");

const app = express();
app.use(cors());
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


// ========== Agency ↔ Title Mapping ==========
app.get("/api/agency-title-map", async (req, res) => {
  try {
    const agencies = metadataCache.get("agenciesMetadata") || [];
    const map = {};

    agencies.forEach(agency => {
      const slug = agency.slug;
      const titles = (agency.cfr_references || []).map(ref => ref.title);
      if (slug && titles.length > 0) {
        map[slug] = [...new Set(titles)];
      }
    });

    res.json({ map });
  } catch (err) {
    console.error("🚨 Failed to generate agency-title map:", err.message);
    res.status(500).json({ error: "Failed to generate agency-title map" });
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


// ===================== Word Count by Agency =====================
app.get("/api/wordcount/agency/:slug", async (req, res) => {
  const sax = require("sax");

  const slug = req.params.slug;
  const agencies = metadataCache.get("agenciesMetadata") || [];
  const agency = agencies.find(
    (a) => a.slug === slug || a.name.toLowerCase().replace(/\s+/g, "-") === slug
  );
  if (!agency) return res.status(404).json({ error: "Agency not found" });

  // 🎯 Hardcoded CFR reference overwrite for known problematic agencies
  if (slug === "federal-procurement-regulations-system") {
    // Intentionally empty — return zero count
    return res.json({ agency: agency.name, total: 0, breakdowns: [] });
  }

  if (slug === "federal-property-management-regulations-system") {
    agency.cfr_references = [{ title: 41, subtitle: "C" }];
  } else if (slug === "federal-travel-regulation-system") {
    agency.cfr_references = [{ title: 41, subtitle: "F" }];
  } else if (slug === "department-of-defense") {
    agency.cfr_references = [
      { title: 2, chapter: "XI" },
      { title: 5, chapter: "XXVI" },
      { title: 32, subtitle: "A" },
      { title: 40, chapter: "VII" }
    ];
  } else if (slug === "department-of-health-and-human-services") {
    agency.cfr_references = [
      { title: 2, chapter: "III" },
      { title: 5, chapter: "XLV" },
      { title: 45, subtitle: "A" },
      { title: 48, chapter: "3" }
    ];
  } else if (slug === "office-of-management-and-budget") {
    agency.cfr_references = [
      { title: 2, subtitle: "A" },
      { title: 5, chapter: "III" },
      { title: 5, chapter: "LXXVII" },
      { title: 48, chapter: "99" }
    ];
  }

  const refs = agency.cfr_references || [];
  if (!refs.length) return res.json({ agency: agency.name, total: 0, breakdowns: [] });

  let totalWords = 0;
  const breakdowns = [];

  for (const ref of refs) {
    const title = ref.title;
    const chapter = ref.chapter || null;
    const subtitle = ref.subtitle || null;

    const cacheKey = `agency-scope-${slug}-title-${title}-${chapter || subtitle || "none"}`;
    let cachedCount = wordCountCache.get(cacheKey);
    if (cachedCount !== undefined) {
      breakdowns.push({ title, chapter: chapter || subtitle || null, wordCount: cachedCount });
      totalWords += cachedCount;
      continue;
    }

    try {
      const titles = metadataCache.get("titlesMetadata") || [];
      const meta = titles.find((t) => t.number.toString() === title.toString());
      const issueDate = meta?.latest_issue_date;
      if (!issueDate) continue;

      const structureUrl = `${VERSIONER}/structure/${issueDate}/title-${title}.json`;
      const structure = (await axios.get(structureUrl)).data;

      const sectionSet = new Set();

      // 🔍 Locate entry node
      let matchedNode = null;
      const findNode = (node) => {
        if (!node || typeof node !== "object") return null;
        if (subtitle && node.type === "subtitle" && node.identifier === subtitle) return node;
        if (!subtitle && chapter && node.type === "chapter" && node.identifier === chapter) return node;
        if (node.children) {
          for (const child of node.children) {
            const result = findNode(child);
            if (result) return result;
          }
        }
        return null;
      };

      matchedNode = findNode(structure);

      const collectSections = (node) => {
        if (node.type === "section") sectionSet.add(node.identifier);
        if (node.children) node.children.forEach(collectSections);
      };

      if (matchedNode) {
        collectSections(matchedNode);
      }

      if (!sectionSet.size) {
        console.warn(`⚠️ No sections under matched node for Title ${title}, Chapter ${chapter || subtitle}, Type ${matchedNode?.type || "N/A"}`);
        breakdowns.push({ title, chapter: chapter || subtitle || null, wordCount: 0 });
        continue;
      }

      // STEP 2: XML streaming word count
      const xmlUrl = `${VERSIONER}/full/${issueDate}/title-${title}.xml`;
      const response = await axios({ method: "GET", url: xmlUrl, responseType: "stream", timeout: 60000 });
      const parser = sax.createStream(true);

      let currentSection = null, captureText = false, currentText = "", wordCount = 0;
      const stack = [];

      parser.on("opentag", (node) => {
        const { name, attributes } = node;
        if (name.startsWith("DIV") && attributes.TYPE && attributes.N) {
          stack.push({ type: attributes.TYPE.toLowerCase(), number: attributes.N });
          if (attributes.TYPE.toLowerCase() === "section" && sectionSet.has(attributes.N)) {
            currentSection = attributes.N;
          }
        }
        if (currentSection && ["P", "FP", "HD", "HEAD", "GPOTABLE"].includes(name)) {
          captureText = true;
        }
      });

      parser.on("text", (text) => {
        if (captureText && currentSection) currentText += text.trim() + " ";
      });

      parser.on("closetag", (tag) => {
        if (captureText && ["P", "FP", "HD", "HEAD", "GPOTABLE"].includes(tag)) captureText = false;
        if (tag.startsWith("DIV") && stack.length > 0) {
          const popped = stack.pop();
          if (popped.type === "section" && popped.number === currentSection) {
            wordCount += currentText.trim().split(/\s+/).filter(Boolean).length;
            currentSection = null;
            currentText = "";
          }
        }
      });

      parser.on("end", () => {
        wordCountCache.set(cacheKey, wordCount);
        breakdowns.push({ title, chapter: chapter || subtitle || null, wordCount });
        totalWords += wordCount;
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


// =============== 🐿️ Cyber Squirrel Search Engine v3.0 — JSON Index-Based ===================
const fs = require("fs");
const path = require("path");

// NEW CYBER SQUIRREL ROUTE (JSON-INDEX BASED SEARCH)
app.get("/api/search/cyber-squirrel", async (req, res) => {
  const query = (req.query.q || "").toLowerCase().trim();
  const titleFilter = req.query.title ? parseInt(req.query.title) : null;

  const rawAgencyInput = req.query["agency_slugs[]"] || req.query.agency_slugs || req.query.agency;
  const normalizeSlug = (val) => typeof val === "string" ? val.toLowerCase().trim().replace(/\s+/g, "-") : "";
  const agencyFilter = normalizeSlug(Array.isArray(rawAgencyInput) ? rawAgencyInput[0] : rawAgencyInput);

  const matchedResults = [];
  console.log(`🛫 Cyber Squirrel Search → Query: "${query}" | Title: ${titleFilter || "None"} | Agency: ${agencyFilter || "None"}`);

  if (!query && !titleFilter && !agencyFilter) {
    console.log("⚠️ Empty query and no filters — exiting.");
    return res.json({ results: [] });
  }

  const titles = metadataCache.get("titlesMetadata") || [];
  const agencies = metadataCache.get("agenciesMetadata") || [];
  const indexDir = path.join(__dirname, "eCFR-index-files");

  // 📌 TITLE-ONLY filter (no query)
  if (!query && titleFilter) {
    const titleMeta = titles.find(t => parseInt(t.number) === titleFilter);
    if (titleMeta) {
      matchedResults.push({
        section: `Title ${titleFilter}`,
        heading: titleMeta.name || "",
        excerpt: "Root of selected title.",
        link: `https://www.ecfr.gov/current/title-${titleFilter}`
      });
    }
    return res.json({ results: matchedResults });
  }

  // 📌 AGENCY-ONLY filter (no query)
  if (!query && agencyFilter) {
    const agency = agencies.find(a => a.slug === agencyFilter || normalizeSlug(a.name) === agencyFilter);
    if (!agency) return res.json({ results: [] });

    if (agency.cfr_references?.length > 0) {
      agency.cfr_references.forEach(ref => {
        const url = ref.subtitle
          ? `https://www.ecfr.gov/current/title-${ref.title}/subtitle-${ref.subtitle}`
          : ref.chapter
          ? `https://www.ecfr.gov/current/title-${ref.title}/chapter-${ref.chapter}`
          : `https://www.ecfr.gov/current/title-${ref.title}`;
        matchedResults.push({
          section: agency.name,
          heading: `CFR Reference: Title ${ref.title}${ref.subtitle ? ` Subtitle ${ref.subtitle}` : ref.chapter ? ` Chapter ${ref.chapter}` : ""}`,
          excerpt: "Root of selected agency CFR reference.",
          link: url
        });
      });
    } else {
      console.warn("⚠️ Agency has no CFR references.");
    }
    return res.json({ results: matchedResults });
  }

  // 📚 Determine scoped titles (based on filters)
  const scopedTitles = [];
  let scopedAgencyRefs = [];

  if (agencyFilter) {
    const agency = agencies.find(a => a.slug === agencyFilter || normalizeSlug(a.name) === agencyFilter);
    if (agency?.cfr_references?.length > 0) {
      scopedAgencyRefs = agency.cfr_references;
      scopedTitles.push(...scopedAgencyRefs.map(ref => parseInt(ref.title)));
    }
  }

  if (titleFilter && !scopedTitles.includes(titleFilter)) {
    scopedTitles.push(titleFilter);
  }

  const filesToLoad = [];

  // 📦 Determine which JSON index files to load
  const allFiles = fs.readdirSync(indexDir);
  allFiles.forEach(file => {
    if (!file.endsWith(".json")) return;

    const titleMatch = file.match(/title-(\d+)/);
    const titleNum = titleMatch ? parseInt(titleMatch[1]) : null;

    if (titleNum) {
      if (query && !titleFilter && !agencyFilter) {
        filesToLoad.push(file); // Query-only: load all files
      } else if (scopedTitles.includes(titleNum)) {
        filesToLoad.push(file); // Filtered: load only scoped titles
      }
    }
  });

  // 🔍 Search files
  for (const fileName of filesToLoad) {
    try {
      const filePath = path.join(indexDir, fileName);
      const content = JSON.parse(fs.readFileSync(filePath, "utf8"));

      for (const section of content) {
        const headingLower = (section.heading || "").toLowerCase();
        const bodyLower = (section.content || "").toLowerCase();

        const headingMatch = headingLower.includes(query);
        const bodyMatch = bodyLower.includes(query);

        if (headingMatch || bodyMatch) {
          matchedResults.push({
            section: section.section,
            heading: section.heading,
            title: `Title ${section.title}`,
            excerpt: section.content?.substring(0, 500) + "...",
            link: section.url,
            matchType: headingMatch ? "Heading Match" : "Body Text Match",
            relevanceScore: headingMatch ? 2 : 1
          });
        }
      }

      console.log(`✅ Searched ${fileName} → ${matchedResults.length} matches total so far`);
    } catch (err) {
      console.error(`❌ Failed to process ${fileName}: ${err.message}`);
    }
  }

  // 📈 Sort by relevance
  const finalResults = matchedResults.sort((a, b) => {
    const scoreDiff = (b.relevanceScore || 0) - (a.relevanceScore || 0);
    return scoreDiff !== 0 ? scoreDiff : a.section.localeCompare(b.section);
  });

  console.log(`🎯 Search completed → ${finalResults.length} results`);
  return res.json({ results: finalResults });
});





// ===================== Suggestions (Enhanced + ECFR Merge) =====================
app.get("/api/search/suggestions", async (req, res) => {
  const query = (req.query.query || "").toLowerCase().trim();
  if (!query) return res.json({ suggestions: [] });

  try {
    const cacheKey = `suggestions-${query}`;
    if (suggestionCache.has(cacheKey)) return res.json({ suggestions: suggestionCache.get(cacheKey) });

    const titles = metadataCache.get("titlesMetadata") || [];
    const agencies = metadataCache.get("agenciesMetadata") || [];

    let suggestions = [];

    // 1️⃣ Local title/agency matches
    titles.forEach(t => {
      if (t.name.toLowerCase().includes(query)) suggestions.push(`Title ${t.number}: ${t.name}`);
    });
    agencies.forEach(a => {
      if (a.name.toLowerCase().includes(query)) suggestions.push(a.name);
    });

    // 2️⃣ Section headings (new internal addition)
    if (metadataCache.has("sectionHeadings")) {
      const headings = metadataCache.get("sectionHeadings") || [];
      headings.forEach(h => {
        if (h.toLowerCase().includes(query)) suggestions.push(h);
      });
    }

    // 3️⃣ ECFR /api/search/v1/suggestions merge (retry)
    try {
      const ecfrResponse = await axios.get(`${BASE_URL}/api/search/v1/suggestions?query=${encodeURIComponent(query)}`);
      if (Array.isArray(ecfrResponse.data.suggestions)) {
        suggestions.push(...ecfrResponse.data.suggestions);
      }
    } catch (e) {
      console.warn("⚠️ ECFR Suggestions fallback failed:", e.message);
    }

    suggestions = [...new Set(suggestions)].slice(0, 15); // Dedupe + trim
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

    console.log("✅ Metadata preload complete");
    console.log("🛫 Cyber Squirrel Search Engine initialized"); 

  } catch (e) {
    console.error("🚨 Metadata preload failed:", e.message);
  }
})();


// ===================== Start Server =====================
app.listen(PORT, () => {
  console.log(`🚀 eCFR Analyzer server running on port ${PORT}`);
});
