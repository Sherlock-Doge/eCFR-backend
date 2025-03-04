const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // ✅ Fixes CORS issues
app.use(express.json());

// ✅ Fetch eCFR Agencies
app.get("/api/agencies", async (req, res) => {
    try {
        const response = await fetch("https://www.ecfr.gov/api/admin/v1/agencies.json");
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch agencies" });
    }
});

// ✅ Fetch eCFR Corrections
app.get("/api/corrections", async (req, res) => {
    try {
        const response = await fetch("https://www.ecfr.gov/api/admin/v1/corrections.json");
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch corrections" });
    }
});

// ✅ Fetch eCFR Titles
app.get("/api/titles", async (req, res) => {
    try {
        const response = await fetch("https://www.ecfr.gov/api/versioner/v1/titles.json");
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch titles" });
    }
});

// ✅ Start Server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

