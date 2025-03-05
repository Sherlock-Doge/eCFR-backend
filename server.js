const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_API = "https://www.ecfr.gov/api/versioner/v1";

// 📌 Middleware to enable CORS for ALL routes
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); // ✅ Allows all origins (including GitHub Pages)
    res.header("Access-Control-Allow-Methods", "GET"); // ✅ Restrict to GET requests
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
});

// 📌 Fetch all eCFR Titles
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

// 📌 Fetch Word Counts
app.get("/api/wordcounts", async (req, res) => {
    try {
        console.log("📥 Fetching word counts...");
        const response = await axios.get("https://www.ecfr.gov/api/search/v1/counts/hierarchy");
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error fetching word counts:", error.message);
        res.status(500).json({ error: "Failed to fetch word count data" });
    }
});

// 📌 Fetch Ancestry for a Title
app.get("/api/ancestry/:title", async (req, res) => {
    const titleNumber = req.params.title;
    const today = new Date().toISOString().split("T")[0];
    const url = `${BASE_API}/ancestry/${today}/title-${titleNumber}.json`;

    try {
        console.log(`🔍 Fetching ancestry for Title ${titleNumber}...`);
        const response = await axios.get(url);
        res.json(response.data);
    } catch (error) {
        console.error(`🚨 Error fetching ancestry for Title ${titleNumber}:`, error.message);
        res.status(500).json({ error: "Failed to fetch ancestry data" });
    }
});

// 📌 Fetch Agencies
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
