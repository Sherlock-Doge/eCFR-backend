const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// ✅ Initialize Cache (Persists Data for 24 Hours)
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

// 📌 Fetch Word Counts (Cached)
app.get("/api/wordcounts", async (req, res) => {
    let cachedWordCounts = wordCountCache.get("wordCounts");
    if (cachedWordCounts) {
        console.log("✅ Returning cached word counts");
        return res.json(cachedWordCounts);
    }

    try {
        console.log("📥 Fetching word counts from eCFR API...");
        const response = await axios.get(`${BASE_URL}/api/search/v1/counts/hierarchy`);
        
        // ✅ Process response and map word counts to Titles
        let wordCounts = {};
        if (response.data.children) {
            response.data.children.forEach(title => {
                if (title.level === "title" && title.hierarchy && title.count) {
                    wordCounts[title.hierarchy] = title.count;
                }
            });
        }

        // ✅ Cache word counts
        wordCountCache.set("wordCounts", wordCounts);
        console.log("✅ Word counts updated and cached.");

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
