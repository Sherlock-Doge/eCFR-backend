// ✅ Backend URL (Updated to new backend service)
const BACKEND_URL = "https://ecfr-backend-service.onrender.com";

// 📌 Fetch eCFR Titles from Backend
async function fetchTitles() {
    try {
        console.log("📥 Fetching eCFR Titles...");
        const response = await fetch(`${BACKEND_URL}/api/titles`);
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        const data = await response.json();
        console.log("✅ Titles Data:", data);
        return data.titles || [];
    } catch (error) {
        console.error("🚨 Error fetching titles:", error);
        return [];
    }
}

// 📌 Fetch Agency Data from Backend
async function fetchAgencies() {
    try {
        console.log("📥 Fetching agency data...");
        const response = await fetch(`${BACKEND_URL}/api/agencies`);
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        const data = await response.json();
        console.log("✅ Agencies Data:", data);
        return data.agencies || [];
    } catch (error) {
        console.error("🚨 Error fetching agencies:", error);
        return [];
    }
}

// 📌 Fetch Word Count for a Single Title
async function fetchSingleTitleWordCount(titleNumber, buttonElement) {
    try {
        console.log(`📥 Fetching word count for Title ${titleNumber}...`);
        buttonElement.textContent = "Fetching...";
        buttonElement.disabled = true;
        const statusText = document.createElement("span");
        statusText.textContent = " This may take a few moments...";
        statusText.style.color = "gray";
        buttonElement.parentElement.appendChild(statusText);
        const response = await fetch(`${BACKEND_URL}/api/wordcount/${titleNumber}`);
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        const data = await response.json();
        console.log(`✅ Word Count for Title ${titleNumber}:`, data.wordCount);
        buttonElement.parentElement.innerHTML = data.wordCount.toLocaleString();
    } catch (error) {
        console.error(`🚨 Error fetching word count for Title ${titleNumber}:`, error);
        buttonElement.textContent = "Retry";
        buttonElement.disabled = false;
    }
}

// 📌 Update Scoreboard
function updateScoreboard(totalTitles, totalAgencies, mostRecentTitle, mostRecentDate, mostRecentTitleName) {
    document.getElementById("totalTitles").textContent = totalTitles;
    document.getElementById("totalAgencies").textContent = totalAgencies > 0 ? totalAgencies : "N/A";
    const recentAmendedTitleElement = document.getElementById("recentAmendedTitle");
    if (mostRecentTitle && mostRecentTitleName) {
        recentAmendedTitleElement.href = `https://www.ecfr.gov/current/title-${mostRecentTitle.replace("Title ", "")}`;
        recentAmendedTitleElement.textContent = `${mostRecentTitle} - ${mostRecentTitleName}`;
    } else {
        recentAmendedTitleElement.textContent = "N/A";
        recentAmendedTitleElement.removeAttribute("href");
    }
    document.getElementById("recentAmendedDate").textContent = mostRecentDate ? `(${mostRecentDate})` : "(N/A)";
}

// 📌 Populate Table
async function fetchData() {
    console.log("📥 Starting data fetch...");
    const tableBody = document.querySelector("#titlesTable tbody");
    if (tableBody) tableBody.innerHTML = "";
    try {
        const [titles, agencies] = await Promise.all([fetchTitles(), fetchAgencies()]);
        if (!titles.length) {
            console.error("🚨 No Titles Data Received!");
            return;
        }
        let mostRecentTitle = null;
        let mostRecentTitleName = null;
        let mostRecentDate = null;
        titles.forEach(title => {
            const titleUrl = `https://www.ecfr.gov/current/title-${title.number}`;
            if (!mostRecentDate || (title.latest_amended_on && title.latest_amended_on > mostRecentDate)) {
                mostRecentDate = title.latest_amended_on;
                mostRecentTitle = `Title ${title.number}`;
                mostRecentTitleName = title.name;
            }
            const row = document.createElement("tr");
            row.innerHTML = `
                <td><a href="${titleUrl}" target="_blank">Title ${title.number} - ${title.name}</a></td>
                <td>${title.up_to_date_as_of || "N/A"}</td>
                <td>${title.latest_amended_on || "N/A"}</td>
                <td><button onclick="fetchSingleTitleWordCount(${title.number}, this)">Generate</button></td>
            `;
            if (tableBody) tableBody.appendChild(row);
        });
        updateScoreboard(titles.length, agencies.length, mostRecentTitle, mostRecentDate, mostRecentTitleName);
        console.log("✅ Table populated successfully.");
    } catch (error) {
        console.error("🚨 Error in fetchData():", error);
    }
}

// 📌 Start Fetching Data on Load
fetchData();

// ✅ ENHANCED SEARCH FUNCTIONS
async function performSearch() {
    const query = document.getElementById("searchQuery").value.trim();
    const agencyFilter = document.getElementById("agencyFilter").value;
    const titleFilter = document.getElementById("titleFilter").value;
    const startDate = document.getElementById("startDate").value;
    const endDate = document.getElementById("endDate").value;
    const resultsContainer = document.getElementById("searchResults");

    if (!query) {
        resultsContainer.innerHTML = "<p>Please enter a search term.</p>";
        return;
    }

    console.log(`🔍 Searching for: ${query}`);
    document.body.classList.add("search-results-visible");
    resultsContainer.innerHTML = "<p>Loading results...</p>";

    const url = new URL("https://www.ecfr.gov/api/search/v1/results");
    url.searchParams.append("query", query);
    if (agencyFilter) url.searchParams.append("agency_slugs[]", agencyFilter);
    if (titleFilter) url.searchParams.append("title", titleFilter);
    if (startDate) url.searchParams.append("last_modified_on_or_after", startDate);
    if (endDate) url.searchParams.append("last_modified_on_or_before", endDate);

    try {
        const response = await fetch(url.toString());
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        const data = await response.json();
        resultsContainer.innerHTML = "";
        if (!data.results || data.results.length === 0) {
            resultsContainer.innerHTML = "<p>No results found.</p>";
        } else {
            data.results.forEach((result, index) => {
                const div = document.createElement("div");
                div.classList.add("search-result");
                div.innerHTML = `
                    <p><strong>${index + 1}.</strong> <a href="https://www.ecfr.gov/${result.link}" target="_blank">${result.title || "No title"}</a></p>
                    <p>${result.description || "No description available."}</p>
                `;
                resultsContainer.appendChild(div);
            });
        }
    } catch (error) {
        console.error("🚨 Error performing search:", error);
        resultsContainer.innerHTML = "<p>Error retrieving search results.</p>";
    }
}

// ✅ REAL-TIME SEARCH SUGGESTIONS
document.getElementById("searchQuery").addEventListener("input", async function () {
    const query = this.value.trim();
    const suggestionBox = document.getElementById("searchSuggestions");
    if (!query) {
        suggestionBox.innerHTML = "";
        suggestionBox.style.display = "none";
        return;
    }

    try {
        const response = await fetch(`https://www.ecfr.gov/api/search/v1/suggestions?query=${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const data = await response.json();
        suggestionBox.innerHTML = "";
        if (data.suggestions && data.suggestions.length > 0) {
            suggestionBox.style.display = "block";
            data.suggestions.forEach(s => {
                const item = document.createElement("div");
                item.className = "suggestion-item";
                item.textContent = s;
                item.onclick = () => {
                    document.getElementById("searchQuery").value = s;
                    suggestionBox.innerHTML = "";
                    suggestionBox.style.display = "none";
                    performSearch();
                };
                suggestionBox.appendChild(item);
            });
        } else {
            suggestionBox.style.display = "none";
        }
    } catch (err) {
        console.error("🚨 Error fetching suggestions:", err);
        suggestionBox.style.display = "none";
    }
});

// ✅ ENTER KEY TO SEARCH
document.getElementById("searchQuery").addEventListener("keypress", function (event) {
    if (event.key === "Enter") {
        event.preventDefault();
        performSearch();
    }
});
