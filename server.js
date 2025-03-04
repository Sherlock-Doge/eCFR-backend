const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

const BASE_API = "https://www.ecfr.gov/api/versioner/v1";

// 📌 Function to fetch hierarchy with retry and delay
async function fetchHierarchy(titleNumber, retries = 5, delay = 2000) {
    const today = new Date().toISOString().split("T")[0];
    const url = `${BASE_API}/structure/${today}/title-${titleNumber}.json`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`🔍 Fetching hierarchy for Title ${titleNumber} (Attempt ${attempt})...`);
            const response = await axios.get(url);
            if (response.data && response.data.children) {
                return response.data.children; // ✅ Return hierarchy data
            } else {
                console.warn(`⚠️ No hierarchy found for Title ${titleNumber}. Retrying...`);
            }
        } catch (error) {
            if (error.response?.status === 429) {
                console.warn(`⚠️ Rate limit (429) for Title ${titleNumber}, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay)); // Wait before retrying
                delay *= 2; // ⏳ Increase wait time for next attempt
            } else {
                console.error(`🚨 Failed to fetch hierarchy for Title ${titleNumber}:`, error.message);
                return [];
            }
        }
    }
    console.error(`❌ Final failure for Title ${titleNumber}, returning empty hierarchy.`);
    return [];
}

// 📌 Fetch all titles & include hierarchy data
app.get("/api/titles", async (req, res) => {
    try {
        console.log("📥 Fetching all titles...");
        const response = await axios.get(`${BASE_API}/titles.json`);
        const titles = response.data.titles;

        const fullTitlesData = [];
        for (let title of titles) {
            console.log(`⏳ Processing Title ${title.number}...`);
            const hierarchy = await fetchHierarchy(title.number);
            fullTitlesData.push({ ...title, hierarchy });
            await new Promise(resolve => setTimeout(resolve, 3000)); // ⏳ Wait 3s between requests
        }

        console.log("✅ Finished fetching all titles with hierarchy.");
        res.json({ titles: fullTitlesData });
    } catch (error) {
        console.error("🚨 Error fetching titles:", error);
        res.status(500).json({ error: "Failed to fetch title hierarchy" });
    }
});

// 📌 Start the server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
