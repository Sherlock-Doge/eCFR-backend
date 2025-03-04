const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

const BASE_API = "https://www.ecfr.gov/api/versioner/v1";
const ADMIN_API = "https://www.ecfr.gov/api/admin/v1";

// ✅ Fetch Titles with Full Hierarchy (Title → Subtitle → Chapter → Subchapter → Part → Section)
app.get("/api/titles", async (req, res) => {
    try {
        const today = new Date().toISOString().split("T")[0]; // Get current date YYYY-MM-DD
        const response = await axios.get(`${BASE_API}/titles.json`);
        const titles = response.data.titles;

        // Fetch hierarchy & structure for each title
        const hierarchyPromises = titles.map(async (title) => {
            try {
                console.log(`🔍 Fetching full hierarchy for Title ${title.number}...`);

                // Get Full Hierarchy (Ancestry)
                const ancestryResponse = await axios.get(`${BASE_API}/ancestry/${today}/title-${title.number}.json`);
                
                // Get Structure Data
                const structureResponse = await axios.get(`${BASE_API}/structure/${today}/title-${title.number}.json`);

                return {
                    ...title,
                    hierarchy: ancestryResponse.data || [],
                    structure: structureResponse.data || []
                };
            } catch (error) {
                console.warn(`⚠️ Failed to fetch ancestry/structure for Title ${title.number}`);
                return { ...title, hierarchy: [], structure: [] };
            }
        });

        // Fetch Agencies
        console.log("🔍 Fetching agency data...");
        const agenciesResponse = await axios.get(`${ADMIN_API}/agencies.json`);
        const agencies = agenciesResponse.data.agencies;

        const fullTitlesData = await Promise.all(hierarchyPromises);

        res.json({ titles: fullTitlesData, agencies });
    } catch (error) {
        console.error("🚨 Error fetching full hierarchy:", error);
        res.status(500).json({ error: "Failed to fetch title hierarchy" });
    }
});

// ✅ Fetch Word Count for a Given Part
app.get("/api/wordcount/:title/:part", async (req, res) => {
    try {
        const { title, part } = req.params;
        const response = await axios.get(`${BASE_API}/full/latest/title-${title}.xml`);

        if (!response.data) {
            return res.json({ title, part, wordCount: 0 });
        }

        const textContent = response.data.replace(/<[^>]*>/g, ""); // Remove XML tags
        const wordCount = textContent.split(/\s+/).filter(word => word.length > 0).length;

        res.json({ title, part, wordCount });
    } catch (error) {
        console.error("🚨 Error fetching word count:", error);
        res.status(500).json({ error: "Failed to fetch word count" });
    }
});

// ✅ Start Server
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
