const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // ✅ Fixes CORS issues
app.use(express.json());

console.log(`✅ Server is starting on port ${PORT}...`);

// ✅ Homepage route to confirm backend is running
app.get("/", (req, res) => {
    res.send("✅ Backend is running successfully! 🎉");
});

// ✅ Helper function to fetch eCFR data
async function fetchAPI(url, res) {
    try {
        console.log(`Fetching: ${url}`);
        const response = await fetch(url);

        if (!response.ok) {
            console.log(`Error fetching ${url}: ${response.status}`);
            return res.status(response.status).json({ error: `Failed to fetch ${url}` });
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error(`🚨 Fetch error: ${error.message}`);
        res.status(500).json({ error: "Server error fetching data" });
    }
}

// ✅ API routes to fetch real eCFR data
app.get("/api/agencies", (req, res) => {
    fetchAPI("https://www.ecfr.gov/api/admin/v1/agencies.json", res);
});

app.get("/api/corrections", (req, res) => {
    fetchAPI("https://www.ecfr.gov/api/admin/v1/corrections.json", res);
});

app.get("/api/titles", (req, res) => {
    fetchAPI("https://www.ecfr.gov/api/versioner/v1/titles.json", res);
});

// ✅ Start Server (IMPORTANT: "0.0.0.0" required for Render)
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on port ${PORT}`));
