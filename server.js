const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const sax = require("sax");
const fs = require("fs"); //added to support/api/wordcount/agency-fast/:slug
const path = require("path"); //added to support/api/wordcount/agency-fast/:slug
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

// ===================== Word Count by Agency (FINAL CLEAN MERGED STRATEGY - NO GUESSWORK) =====================

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


// ===================== 🐿️ Cyber Squirrel Search Engine — Final Clean Unified Version =====================
app.get("/api/search/cyber-squirrel", async (req, res) => {
  // STEP 1: Extract query and filters from URL
  const query = (req.query.q || "").toLowerCase().trim();
  const titleFilter = req.query.title ? parseInt(req.query.title) : null;

  // ✅ SAFELY normalize agency slug input, whether string or array
  const rawAgencyInput = req.query["agency_slugs[]"] || req.query.agency_slugs || req.query.agency;
  const rawSlug = Array.isArray(rawAgencyInput) ? rawAgencyInput[0] : rawAgencyInput;
  const normalizeSlug = (val) => (typeof val === "string" ? val.toLowerCase().trim().replace(/\s+/g, "-") : "");
  const agencyFilter = normalizeSlug(rawSlug);

  const matchedResults = [];
  console.log(`🛫 Cyber Squirrel Search → Query: "${query}" | Title: ${titleFilter || "None"} | Agency: ${agencyFilter || "None"}`);

  // STEP 2: If nothing entered at all, exit immediately
  if (!query && !titleFilter && !agencyFilter) {
    console.log("⚠️ Empty query and no filters — exiting.");
    return res.json({ results: [] });
  }

  // STEP 3: TITLE filter only → return title root metadata only
  if (!query && titleFilter) {
    const titles = metadataCache.get("titlesMetadata") || [];
    const titleMeta = titles.find(t => parseInt(t.number) === titleFilter);
    if (titleMeta) {
      console.log(`📘 Title-only mode → returning Title ${titleFilter} root`);
      matchedResults.push({
        section: `Title ${titleFilter}`,
        heading: titleMeta.name || "",
        excerpt: "Root of selected title.",
        link: `https://www.ecfr.gov/current/title-${titleFilter}`
      });
    }
    return res.json({ results: matchedResults });
  }

  // STEP 4: AGENCY filter only (no keyword) → return CFR references
  if (!query && agencyFilter) {
    const agencies = metadataCache.get("agenciesMetadata") || [];
    const agency = agencies.find(
      a => a.slug === agencyFilter || normalizeSlug(a.name) === agencyFilter
    );

    console.log("🔍 DEBUG AGENCY OBJECT →", JSON.stringify(agency, null, 2));
    if (!agency) {
      console.warn("❌ Agency not found — exiting.");
      return res.json({ results: [] });
    }

    if (agency.cfr_references?.length > 0) {
      console.log(`📦 Agency-only mode: ${agency.name} (${agency.cfr_references.length} CFR refs)`);
      agency.cfr_references.forEach(ref => {
        const title = ref.title;
        const chapter = ref.chapter || null;
        const subtitle = ref.subtitle || null;
        const url = subtitle
          ? `https://www.ecfr.gov/current/title-${title}/subtitle-${subtitle}`
          : chapter
            ? `https://www.ecfr.gov/current/title-${title}/chapter-${chapter}`
            : `https://www.ecfr.gov/current/title-${title}`;
        matchedResults.push({
          section: agency.name,
          heading: `CFR Reference: Title ${title}${subtitle ? ` Subtitle ${subtitle}` : chapter ? ` Chapter ${chapter}` : ""}`,
          excerpt: "Root of selected agency CFR reference.",
          link: url
        });
      });
    } else {
      console.warn("⚠️ Agency has no CFR references.");
    }
    return res.json({ results: matchedResults });
  }

  // STEP 5: KEYWORD SEARCH mode (with optional title/agency filters)
  const titles = metadataCache.get("titlesMetadata") || [];
  const agencies = metadataCache.get("agenciesMetadata") || [];
  const scopedAgencyRefs = [];

  // Match agency object exactly like word count endpoint does
  let agency = null;
  if (agencyFilter) {
    agency = agencies.find(
      a => a.slug === agencyFilter || normalizeSlug(a.name) === agencyFilter
    );
    if (!agency) {
      console.warn("❌ Agency not found — skipping agency scope");
    } else if (agency.cfr_references?.length > 0) {
      scopedAgencyRefs.push(...agency.cfr_references);
    } else {
      console.warn("⚠️ Agency matched but has no CFR references");
    }
  }

  try {
    for (const titleMeta of titles) {
      const titleNumber = parseInt(titleMeta.number);
      if (titleFilter && titleNumber !== titleFilter) continue;
      if (agencyFilter && !scopedAgencyRefs.some(ref => ref.title === titleNumber)) {
        console.log(`🚫 Skipping Title ${titleNumber} — not in agency scope`);
        continue;
      }

      const issueDate = titleMeta.latest_issue_date || titleMeta.up_to_date_as_of;
      if (!issueDate) {
        console.warn(`⚠️ Missing issueDate for Title ${titleNumber} — skipping`);
        continue;
      }

      const structureUrl = `${VERSIONER}/structure/${issueDate}/title-${titleNumber}.json`;
      const structure = (await axios.get(structureUrl)).data;
      console.log(`📥 Structure loaded for Title ${titleNumber}`);

      const sectionSet = new Set();
      const collectSections = (node) => {
        if (node.type === "section") sectionSet.add(node.identifier);
        if (node.children) node.children.forEach(collectSections);
      };

      const findNode = (node, type, id) => {
        if (!node || typeof node !== "object") return null;
        if (node.type === type && node.identifier === id) return node;
        if (node.children) {
          for (const child of node.children) {
            const result = findNode(child, type, id);
            if (result) return result;
          }
        }
        return null;
      };

      if (agencyFilter && scopedAgencyRefs.length > 0) {
        const matchingRefs = scopedAgencyRefs.filter(ref => ref.title === titleNumber);
        matchingRefs.forEach(ref => {
          const entryNode = ref.subtitle
            ? findNode(structure, "subtitle", ref.subtitle)
            : ref.chapter
              ? findNode(structure, "chapter", ref.chapter)
              : structure;
          if (entryNode) {
            collectSections(entryNode);
          }
        });
      } else {
        collectSections(structure);
      }

      if (!sectionSet.size) {
        console.warn(`⚠️ No sections for Title ${titleNumber} — skipping SAX`);
        continue;
      }

      const xmlUrl = `${VERSIONER}/full/${issueDate}/title-${titleNumber}.xml`;
      const response = await axios({
        method: "GET",
        url: xmlUrl,
        responseType: "stream",
        decompress: true,
        headers: { "Accept-Encoding": "gzip, deflate, br" },
        timeout: 60000
      });

      const parser = sax.createStream(true);
      let currentSection = null, currentText = "", captureText = false;
      const stack = [];

      parser.on("opentag", (node) => {
        const { name, attributes } = node;
        if (name.startsWith("DIV") && attributes.TYPE && attributes.N) {
          stack.push({ type: attributes.TYPE.toLowerCase(), number: attributes.N });
          if (attributes.TYPE.toLowerCase() === "section" && sectionSet.has(attributes.N)) {
            currentSection = {
              section: attributes.N,
              heading: attributes.HEADING || "",
              title: titleNumber,
              content: "",
              url: `https://www.ecfr.gov/current/title-${titleNumber}/section-${attributes.N}`
            };
            currentText = "";
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
          if (popped.type === "section" && currentSection && popped.number === currentSection.section) {
            const matchFound = currentText.toLowerCase().includes(query) || currentSection.heading.toLowerCase().includes(query);
            if (matchFound) {
              currentSection.content = currentText.trim();
              matchedResults.push({
                section: currentSection.section,
                heading: currentSection.heading,
                title: `Title ${currentSection.title}`,
                excerpt: currentSection.content.substring(0, 500) + "...",
                link: currentSection.url
              });
              console.log(`✅ MATCH in Section ${currentSection.section} (Title ${titleNumber})`);
            }
            currentSection = null;
            currentText = "";
          }
        }
      });

      parser.on("end", () => console.log(`✅ SAX finished for Title ${titleNumber}`));
      parser.on("error", (err) => console.error(`❌ SAX error Title ${titleNumber}:`, err.message));

      await new Promise((resolve, reject) =>
        response.data.pipe(parser).on("end", resolve).on("error", reject)
      );
    }

    console.log(`🎯 Search Done → ${matchedResults.length} matches`);
    res.json({ results: matchedResults });
  } catch (err) {
    console.error("🔥 Search engine failure:", err.message);
    res.status(500).json({ error: "Search engine failure." });
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

