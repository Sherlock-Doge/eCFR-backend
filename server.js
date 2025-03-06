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

// 📌 Fetch Word Counts from Backend
async function fetchWordCounts() {
    try {
        console.log("📥 Fetching word counts...");
        const response = await fetch(`${BACKEND_URL}/api/wordcounts`);
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

        const wordData = await response.json();
        console.log("✅ Word Count Data:", wordData);
        return wordData || {};
    } catch (error) {
        console.error("🚨 Error fetching word counts:", error);
        return {};
    }
}

// 📌 Fetch Single Title Word Count
async function fetchSingleTitleWordCount(titleNumber, buttonElement) {
    try {
        console.log(`📥 Fetching word count for Title ${titleNumber}...`);
        buttonElement.textContent = "Fetching..."; // Show loading state

        const response = await fetch(`${BACKEND_URL}/api/wordcount/${titleNumber}`);
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

        const data = await response.json();
        console.log(`✅ Word Count for Title ${titleNumber}:`, data.wordCount);

        // ✅ Update button with word count
        buttonElement.replaceWith(document.createTextNode(data.wordCount.toLocaleString()));
    } catch (error) {
        console.error(`🚨 Error fetching word count for Title ${titleNumber}:`, error);
        buttonElement.textContent = "Retry"; // Allow retry
    }
}

// 📌 Update Scoreboard (includes most recently amended title logic)
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

    document.getElementById("recentAmendedDate").textContent = mostRecentDate || "N/A";
}

// 📌 Main Function to Fetch and Populate Table
async function fetchData() {
    const tableBody = document.querySelector("#titlesTable tbody");
    tableBody.innerHTML = "";

    // 📌 Fetch Titles, Agencies & Word Counts in Parallel
    const [titles, agencies, wordCounts] = await Promise.all([
        fetchTitles(),
        fetchAgencies(),
        fetchWordCounts()
    ]);

    if (!titles.length) {
        console.error("🚨 No Titles Data Received!");
        return;
    }

    let mostRecentTitle = null;
    let mostRecentTitleName = null;
    let mostRecentDate = null;

    // 📌 Populate Table and find the most recently amended title
    titles.forEach(title => {
        console.log(`🔍 Processing Title: ${title.number} - ${title.name}`);

        const titleUrl = `https://www.ecfr.gov/current/title-${title.number}`;

        // ✅ Keep your existing robust logic here:
        if (!mostRecentDate || (title.latest_amended_on && title.latest_amended_on > mostRecentDate)) {
            mostRecentDate = title.latest_amended_on;
            mostRecentTitle = `Title ${title.number}`;
            mostRecentTitleName = title.name;
        }

        // ✅ Display word counts from backend if available
        const wordCountDisplay = wordCounts[title.number] 
            ? wordCounts[title.number].toLocaleString() 
            : `<button onclick="fetchSingleTitleWordCount(${title.number}, this)">Generate</button>`;

        const rowHTML = `
            <tr>
                <td>${title.number}</td>
                <td><a href="${titleUrl}" target="_blank">${title.name}</a></td>
                <td>${title.up_to_date_as_of || "N/A"}</td>
                <td>${title.latest_amended_on || "N/A"}</td>
                <td>${wordCountDisplay}</td>
            </tr>
        `;

        tableBody.insertAdjacentHTML("beforeend", rowHTML);
    });

    updateScoreboard(
        titles.length,
        agencies.length,
        mostRecentTitle,
        mostRecentDate,
        mostRecentTitleName
    );

    console.log("✅ Table populated successfully.");
}

// 📌 Start Fetching Data on Load
fetchData();
