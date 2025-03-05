const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_API = "https://www.ecfr.gov/api/versioner/v1";

// 📌 Middleware to allow JSON responses
app.use(express.json());

// 📌 ✅ Global CORS Fix - This must be applied to **ALL ROUTES**
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); // ✅ Allows all origins (including GitHub Pages)
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

// 📌 Fetch eCFR Titles
app.get("/api/titles", async (req, res) => {
    try {
        console.log("📥 Fetching eCFR Titles...");
        const response = await axios.get(`${BASE_API}/titles.json`);
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error fetching titles:", error.message);
        res.status(500).json({ error: "Failed to fetch title data" });
    }
});

// 📌 Fix Word Count Format Issue
app.get("/api/wordcounts", async (req, res) => {
    try {
        console.log("📥 Fetching word counts...");
        const response = await axios.get("https://www.ecfr.gov/api/search/v1/counts/hierarchy");

        // ✅ Fix Unexpected Response Format
        if (!response.data || !response.data.children) {
            console.error("🚨 Unexpected word count format:", response.data);
            return res.status(500).json({ error: "Invalid word count data" });
        }

        let wordCountMap = {};
        response.data.children.forEach(item => {
            if (item.identifier) {
                wordCountMap[item.identifier] = item.count || 0;
            }
        });

        res.json(wordCountMap);
    } catch (error) {
        console.error("🚨 Error fetching word counts:", error.message);
        res.status(500).json({ error: "Failed to fetch word count data" });
    }
});

// 📌 Fix Ancestry Fetching (Error 500)
app.get("/api/ancestry/:title", async (req, res) => {
    const titleNumber = req.params.title;
    const today = new Date().toISOString().split("T")[0];
    const url = `${BASE_API}/ancestry/${today}/title-${titleNumber}.json`;

    try {
        console.log(`🔍 Fetching ancestry for Title ${titleNumber}...`);
        const response = await axios.get(url);

        if (!response.data || typeof response.data !== "object") {
            console.error(`🚨 Invalid ancestry response for Title ${titleNumber}:`, response.data);
            return res.status(500).json({ error: "Invalid ancestry data" });
        }

        res.json(response.data);
    } catch (error) {
        console.error(`🚨 Error fetching ancestry for Title ${titleNumber}:`, error.message);
        res.status(500).json({ error: `Failed to fetch ancestry for Title ${titleNumber}` });
    }
});

// 📌 Fix Agencies CORS & 404 Issue
app.get("/api/agencies", async (req, res) => {
    try {
        console.log("📥 Fetching agency data...");
        const response = await axios.get("https://www.ecfr.gov/api/admin/v1/agencies.json");
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error fetching agencies:", error.message);
        res.status(500).json({ error: "Failed to fetch agency data" });
    }
});

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
