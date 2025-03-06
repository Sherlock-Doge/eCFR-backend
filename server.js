const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const { JSDOM } = require("jsdom");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// ✅ Initialize Cache (Extended 60-day persistence for efficiency)
const wordCountCache = new NodeCache({ stdTTL: 5184000, checkperiod: 86400 });

// ✅ Auto-Update Word Counts Every 30 Days - FIXED: Runs only when needed
const UPDATE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Days
let lastUpdate = Date.now();

// 📌 ✅ CORS Middleware - Allows frontend access
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

// 📌 Fetch Titles (Summary Info)
app.get("/api/titles", async (req, res) => {
    try {
        console.log("📥 Fetching eCFR Titles...");
        const response = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error fetching titles:", error.message);
        res.status(500).json({ error: "Failed to fetch title data" });
    }
});

// 📌 Fetch Agencies
app.get("/api/agencies", async (req, res) => {
    try {
        console.log("📥 Fetching agency data...");
        const response = await axios.get(`${BASE_URL}/api/admin/v1/agencies.json`);
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error fetching agencies:", error.message);
        res.status(500).json({ error: "Failed to fetch agency data" });
    }
});

// 📌 Fetch Word Count for a Single Title (cached & optimized)
app.get("/api/wordcount/:titleNumber", async (req, res) => {
    const titleNumber = req.params.titleNumber;

    // ✅ Check Cache First
    let cachedWordCount = wordCountCache.get(`wordCount-${titleNumber}`);
    if (cachedWordCount !== undefined) {
        console.log(`✅ Returning cached word count for Title ${titleNumber}`);
        return res.json({ title: titleNumber, wordCount: cachedWordCount });
    }

    try {
        console.log(`📥 Fetching word count for Title ${titleNumber}...`);

        // 🔍 Get Title Issue Date
        const titlesResponse = await axios.get(`${BASE_URL}/api/versioner/v1/titles.json`);
        const titleData = titlesResponse.data.titles.find(t => t.number.toString() === titleNumber);

        if (!titleData) {
            console.warn(`⚠️ Title ${titleNumber} not found`);
            return res.status(404).json({ error: "Title not found" });
        }

        const issueDate = titleData.latest_issue_date;
        console.log(`📥 Processing Title ${titleNumber} (Issued: ${issueDate})...`);

        // 🔄 Fetch XML Content (Handles Large Data Efficiently)
        const xmlUrl = `${BASE_URL}/api/versioner/v1/full/${issueDate}/title-${titleNumber}.xml`;
        const xmlResponse = await fetchLargeXML(xmlUrl);

        if (!xmlResponse) {
            return res.status(500).json({ error: "Failed to fetch XML data" });
        }

        // 🔢 Count Words Using Stream Processing
        const wordCount = countWordsFromXML(xmlResponse);

        // ✅ Cache Result
        wordCountCache.set(`wordCount-${titleNumber}`, wordCount);

        console.log(`📊 Word Count for Title ${titleNumber}: ${wordCount}`);
        res.json({ title: titleNumber, wordCount });
    } catch (error) {
        console.error(`🚨 Error processing Title ${titleNumber}:`, error.message);
        res.status(500).json({ error: "Failed to fetch word count" });
    }
});

// 📌 Efficiently Fetch Large XML Data
async function fetchLargeXML(url) {
    try {
        const response = await axios({
            method: "GET",
            url,
            responseType: "stream", // ✅ Stream Data Instead of Full Load
            timeout: 30000 // ✅ Timeout to prevent server hang-ups
        });

        let xmlData = "";
        response.data.on("data", chunk => {
            xmlData += chunk.toString();
        });

        return new Promise((resolve, reject) => {
            response.data.on("end", () => resolve(xmlData));
            response.data.on("error", reject);
        });
    } catch (error) {
        console.error("🚨 Error fetching large XML:", error.message);
        return null;
    }
}

// 📌 Stream-Optimized Word Count from XML Content
function countWordsFromXML(xmlData) {
    try {
        const dom = new JSDOM(xmlData);
        const textContent = dom.window.document.body.textContent || "";

        // 🔍 Remove Special Characters, Keep Only Words
        const cleanText = textContent.replace(/[^a-zA-Z0-9\s]/g, "");
        const words = cleanText.split(/\s+/).filter(word => word.length > 0);

        return words.length;
    } catch (error) {
        console.error("⚠️ Error parsing XML:", error.message);
        return 0;
    }
}

// 📌 Auto-Update Word Counts (Runs ONCE per Month)
setInterval(() => {
    if (Date.now() - lastUpdate >= UPDATE_INTERVAL_MS) {
        console.log("🔄 Auto-updating word counts...");
        wordCountCache.flushAll();
        lastUpdate = Date.now();
    }
}, 60 * 60 * 1000); // Check every hour

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
