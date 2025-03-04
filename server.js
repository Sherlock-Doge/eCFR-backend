async function fetchTitles() {
    try {
        console.log("📥 Fetching eCFR Titles...");
        const response = await fetch("https://your-backend-url.com/api/titles");
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

        return await response.json();
    } catch (error) {
        console.error("🚨 Error fetching titles:", error);
        return { titles: [] };
    }
}

async function fetchAgencies() {
    try {
        console.log("📥 Fetching agency data...");
        const response = await fetch("https://your-backend-url.com/api/agencies");
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

        return await response.json();
    } catch (error) {
        console.error("🚨 Error fetching agencies:", error);
        return { agencies: [] };
    }
}

async function fetchWordCounts() {
    try {
        console.log("📥 Fetching word counts...");
        const response = await fetch("https://your-backend-url.com/api/wordcounts");
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

        return await response.json();
    } catch (error) {
        console.error("🚨 Error fetching word counts:", error);
        return {};
    }
}

async function fetchData() {
    const tableBody = document.querySelector("#titlesTable tbody");
    tableBody.innerHTML = ""; // Clear table

    const { titles } = await fetchTitles();
    const agenciesData = await fetchAgencies();
    const wordCounts = await fetchWordCounts();

    for (let title of titles) {
        const agency = agenciesData.agencies.find(a => a.cfr_references.some(ref => ref.title == title.number));
        const agencyName = agency ? agency.display_name : "Unknown";

        const titleRow = document.createElement("tr");
        titleRow.classList.add("title-header");
        titleRow.innerHTML = `<td colspan="7"><strong>Title ${title.number} - ${title.name} (${agencyName})</strong></td>`;
        tableBody.appendChild(titleRow);

        if (title.hierarchy && title.hierarchy.length > 0) {
            for (let node of title.hierarchy) {
                if (node.type === "part") {
                    const row = document.createElement("tr");
                    row.innerHTML = `
                        <td></td>
                        <td>${node.parent_label || "N/A"}</td>
                        <td>${node.label || "N/A"}</td>
                        <td>${title.up_to_date_as_of || "N/A"}</td>
                        <td>${title.latest_amended_on || "N/A"}</td>
                        <td>${wordCounts[node.identifier] ? wordCounts[node.identifier].toLocaleString() : "N/A"}</td>
                    `;
                    tableBody.appendChild(row);
                }
            }
        } else {
            const row = document.createElement("tr");
            row.innerHTML = `
                <td colspan="4"></td>
                <td>${title.up_to_date_as_of || "N/A"}</td>
                <td>${title.latest_amended_on || "N/A"}</td>
                <td>N/A</td>
            `;
            tableBody.appendChild(row);
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log("✅ Table populated successfully.");
}

fetchData();
