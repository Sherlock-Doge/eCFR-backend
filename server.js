const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

const BASE_API = "https://www.ecfr.gov/api/versioner/v1";

// Helper function for rate-limited fetching with retries
async function fetchHierarchy(titleNumber, retries = 3, delay = 2000) {
    const today = new Date().toISOString().split("T")[0];
    const url = `${BASE_API}/ancestry/${today}/title-${titleNumber}.json`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`🔍 Fetching hierarchy for Title ${titleNumber} (Attempt ${attempt})...`);
            const response = await axios.get(url);
            return response.data;
        } catch (error) {
            if (error.response?.status === 429) {
                console.warn(`⚠️ Rate limited (429) for Title ${titleNumber}, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay)); // Wait before retrying
                delay *= 2; // Increase delay for next attempt
            } else {
                console.error(`🚨 Failed to fetch hierarchy for Title ${titleNumber}:`, error.message);
                return [];
            }
        }
    }
    console.error(`❌ Final failure for Title ${titleNumber}`);
    return [];
}

// ✅ Fetch Titles with Full Hierarchy (with Rate Limiting)
app.get("/api/titles", async (req, res) => {
    try {
        console.log("📥 Fetching all titles...");
        const response = await axios.get(`${BASE_API}/titles.json`);
        const titles = response.data.titles;

        // Fetch hierarchy one at a time with delay (to avoid 429)
        const fullTitlesData = [];
        for (let title of titles) {
            const hierarchy = await fetchHierarchy(title.number);
            fullTitlesData.push({ ...title, hierarchy });
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay between each request
        }

        res.json({ titles: fullTitlesData });
    } catch (error) {
        console.error("🚨 Error fetching titles:", error);
        res.status(500).json({ error: "Failed to fetch title hierarchy" });
    }
});

// ✅ Start Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
