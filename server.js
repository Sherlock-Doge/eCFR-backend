const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_API = "https://www.ecfr.gov/api/versioner/v1";

// 📌 Middleware to allow JSON responses
app.use(express.json());

// 📌 Fetch all titles & include hierarchy data
app.get("/api/titles", async (req, res) => {
    try {
        console.log("📥 Fetching eCFR Titles...");
        const response = await axios.get(`${BASE_API}/titles.json`);
        if (!response.data || !response.data.titles) {
            console.error("🚨 Invalid response from eCFR titles API.");
            return res.status(500).json({ error: "Invalid title data" });
        }
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error fetching titles:", error.message);
        res.status(500).json({ error: "Failed to fetch title data" });
    }
});

// 📌 Fetch word counts
app.get("/api/wordcounts", async (req, res) => {
    try {
        console.log("📥 Fetching word counts...");
        const response = await axios.get("https://www.ecfr.gov/api/search/v1/counts/hierarchy");
        res.json(response.data);
    } catch (error) {
        console.error("🚨 Error fetching word counts:", error.message);
        res.status(500).json({ error: "Failed to fetch word counts" });
    }
});

// 📌 Fetch ancestry
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

// 📌 Start the server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
