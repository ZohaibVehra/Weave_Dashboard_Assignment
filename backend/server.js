import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// API Routes - put these BEFORE the static file serving
app.get("/api/prs", (req, res) => {
  try {
    const jsonPath = path.join(__dirname, "prs_last_90_days.json");
    const jsonData = readFileSync(jsonPath, "utf8");
    const data = JSON.parse(jsonData);
    
    res.setHeader("Content-Type", "application/json");
    res.json(data);
  } catch (error) {
    console.error("Error reading PRs data:", error);
    res.status(500).json({ error: "Failed to load PRs data" });
  }
});

// Serve static files from the frontend build (dist folder)
app.use(express.static(path.join(__dirname, "../weave_frontend/dist")));

// For any non-API route, serve the React app (SPA fallback)
// Express 5 doesn't support "*" wildcard, so use a middleware function instead
app.use((req, res, next) => {
  // Skip if it's an API route
  if (req.path.startsWith('/api/')) {
    return next();
  }
  // Serve index.html for all other routes (SPA fallback)
  res.sendFile(path.join(__dirname, "../weave_frontend/dist/index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});