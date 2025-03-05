const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = "https://www.ecfr.gov";

// 📌 ✅ CORS Middleware - Allows frontend access from GitHub Pages
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

// 📌 Fetch Title Ancestry (Chapters, Parts, Sections)
app.get("/api/ancestry/:title", async (req, res) => {
    const titleNumber = req.params.title;
    const today = new Date().toISOString().split("T")[0]; // Get today's date
    const url = `${BASE_URL}/api/versioner/v1/ancestry/${today}/title-${titleNumber}.json`;

    try {
        console.log(`🔍 Fetching ancestry for Title ${titleNumber}...`);
        const response = await axios.get(url);
        res.json(response.data);
    } catch (error) {
        console.error(`🚨 Error fetching ancestry for Title ${titleNumber}:`, error.message);
        res.status(500).json({ error: "Failed to fetch ancestry data" });
    }
});

// 📌 Fetch Word Count Data
app.get("/api/wordcounts", async (req, res) => {
    try {
        console.log("📥 Fetching word counts...");
        const response = await axios.get(`${BASE_URL}/api/search/v1/counts/hierarchy`);

        if (!response.data || typeof response.data !== "object") {
            console.error("🚨 Unexpected word count format:", response.data);
            return res.status(500).json({ error: "Invalid word count data" });
        }

        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error fetching word counts:", error.message);
        res.status(500).json({ error: "Failed to fetch word count data" });
    }
});

// 📌 Start the Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
