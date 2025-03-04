const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

const BASE_API = "https://www.ecfr.gov/api/versioner/v1";
const ADMIN_API = "https://www.ecfr.gov/api/admin/v1";

// Helper function to fetch hierarchy with retry logic
async function fetchHierarchy(titleNumber, retries = 3) {
    const today = new Date().toISOString().split("T")[0];
    const url = `${BASE_API}/ancestry/${today}/title-${titleNumber}.json`;

    try {
        console.log(`🔍 Fetching hierarchy for Title ${titleNumber}...`);
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.warn(`⚠️ Failed to fetch hierarchy for Title ${titleNumber}, Retries left: ${retries}`);

        if (retries > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second before retry
            return fetchHierarchy(titleNumber, retries - 1);
        }

        console.error(`🚨 Final failure for Title ${titleNumber}:`, error.response ? error.response.data : error.message);
        return [];
    }
}

// ✅ Fetch Titles with Full Hierarchy
app.get("/api/titles", async (req, res) => {
    try {
        const response = await axios.get(`${BASE_API}/titles.json`);
        const titles = response.data.titles;

        // Fetch hierarchy for each title
        const hierarchyPromises = titles.map(async (title) => {
            const hierarchy = await fetchHierarchy(title.number);
            return { ...title, hierarchy };
        });

        const fullTitlesData = await Promise.all(hierarchyPromises);

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
