const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// ✅ Initialize Cache (24-hour persistence)
const wordCountCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

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

// 📌 Fetch Precomputed Word Counts (Logging FULL API Response)
app.get("/api/wordcounts", async (req, res) => {
    try {
        console.log("📥 Fetching precomputed word counts...");

        // 🔄 Force cache reset before fetching fresh data
        wordCountCache.del("wordCounts");

        // 🔍 Check if cache already has data
        let cachedWordCounts = wordCountCache.get("wordCounts");
        if (cachedWordCounts) {
            console.log("✅ Returning cached word counts");
            return res.json(cachedWordCounts);
        }

        // 🔍 Fetch from eCFR API
        const response = await axios.get(`${BASE_URL}/api/search/v1/counts/hierarchy`);
        console.log("📊 RAW API RESPONSE:", JSON.stringify(response.data, null, 2));

        const rawData = response.data.children;

        if (!rawData || !Array.isArray(rawData)) {
            throw new Error("Invalid word count data format");
        }

        // 📊 Extract title-level word counts
        let wordCounts = {};
        rawData.forEach(title => {
            if (title.level === "title" && title.hierarchy && title.count) {
                wordCounts[title.hierarchy] = title.count;
            }
        });

        console.log("✅ Word counts fetched and cached:", wordCounts);

        // ✅ Save full word count results
        wordCountCache.set("wordCounts", wordCounts);

        res.json(wordCounts);
    } catch (error) {
        console.error("🚨 Error fetching word counts:", error.message);
        res.status(500).json({ error: "Failed to fetch word count data" });
    }
});

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
