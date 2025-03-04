const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

const BASE_API = "https://www.ecfr.gov/api/versioner/v1";

// Helper function to count words in a given text
function countWords(text) {
    if (!text) return 0;
    return text.split(/\s+/).filter(word => word.length > 0).length;
}

// Fetch Titles, Chapters, Subchapters, and Parts
app.get("/api/titles", async (req, res) => {
    try {
        const response = await axios.get(`${BASE_API}/titles.json`);
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch titles" });
    }
});

// Fetch word count for a given Part
app.get("/api/wordcount/:title/:part", async (req, res) => {
    try {
        const { title, part } = req.params;
        const response = await axios.get(`${BASE_API}/full/latest/title-${title}.xml`);

        if (!response.data) {
            return res.json({ title, part, wordCount: 0 });
        }

        const textContent = response.data.replace(/<[^>]*>/g, ""); // Remove XML tags
        const wordCount = countWords(textContent);

        res.json({ title, part, wordCount });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch word count" });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
