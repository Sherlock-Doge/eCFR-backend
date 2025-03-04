const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // ✅ Fixes CORS issues
app.use(express.json());

console.log(`✅ Server is starting on port ${PORT}...`);

// ✅ Add a homepage route
app.get("/", (req, res) => {
    res.send("✅ Backend is running successfully! 🎉");
});

// ✅ Simple test API route
app.get("/api/test", (req, res) => {
    res.json({ message: "Backend is working!" });
});

// ✅ Start Server (IMPORTANT: "0.0.0.0" required for Render)
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on port ${PORT}`));
