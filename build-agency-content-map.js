// build-agency-content-map.js

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// Load your existing agencies list (modify path if different)
const agenciesData = require('./data/agencies.json'); // <- adjust path if needed

const BASE_URL = 'https://www.ecfr.gov';
const STRUCTURE_API = 'https://www.ecfr.gov/api/versioner/v1/structure';
const TODAY = new Date().toISOString().split('T')[0]; // e.g., 2025-03-10

// This will become your master content map
const agencyContentMap = {};

async function buildAgencyMap() {
  console.log(`🛠 Building Agency Content Map from eCFR Structure API...`);

  for (const agency of agenciesData.agencies) {
    const { slug, titles } = agency;
    console.log(`🔍 Processing Agency: ${agency.name} (${slug})`);

    if (!titles || titles.length === 0) {
      console.log(`⚠️ No titles for ${slug}. Skipping...`);
      continue;
    }

    agencyContentMap[slug] = [];

    for (const title of titles) {
      try {
        const structureUrl = `${STRUCTURE_API}/${TODAY}/title-${title}.json`;
        console.log(`📥 Fetching structure: ${structureUrl}`);
        const res = await fetch(structureUrl);
        const structure = await res.json();

        const chapterNodes = structure?.nodes || [];

        for (const chapter of chapterNodes) {
          const chapterId = chapter?.identifier || chapter?.label;
          const chapterEntry = {
            title,
            chapterId,
            parts: []
          };

          const parts = chapter.children || [];

          for (const part of parts) {
            const partId = part?.identifier || part?.label;
            const partPath = part?.identifier || '';
            const partEntry = {
              partId,
              sections: []
            };

            const sections = (part.children || []).map(section => {
              const sectionId = section?.identifier || section?.label || '';
              const sectionUrl = `${BASE_URL}/current/title-${title}/chapter-${chapterId}/part-${partId}/section-${sectionId}`;
              return sectionUrl;
            });

            partEntry.sections = sections;
            chapterEntry.parts.push(partEntry);
          }

          agencyContentMap[slug].push(chapterEntry);
        }

      } catch (err) {
        console.error(`❌ Error processing Title ${title} for ${slug}:`, err.message);
      }
    }
  }

  // Save the output JSON file
  const outputPath = path.join(__dirname, 'agencyContentMap.json');
  fs.writeFileSync(outputPath, JSON.stringify(agencyContentMap, null, 2));
  console.log(`✅ Saved: ${outputPath}`);
}

buildAgencyMap();
