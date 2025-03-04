const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // ✅ Fixes CORS issues
app.use(express.json());

console.log(`✅ Test server running on port ${PORT}...`);

// ✅ Fake test route to check if backend is working
app.get("/api/test", (req, res) => {
    res.json({ message: "Backend is working!" });
});

// ✅ Start Server
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on port ${PORT}`));

