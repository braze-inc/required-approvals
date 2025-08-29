const minimatch = require("minimatch").minimatch;
const path = require("path");

function getCodeowners(codeownersFile, changedFiles) {
  const codeownersLines = codeownersFile.split("\n");

  // Format: { "file": ["@owner1", "@owner2"] }
  const fileOwners = {};
  for (const changedFile of changedFiles) {
    const normalizedFile = `/${changedFile}`;
    let matchedOwners = null;

    // Keep this handy for logging
    let lastMatchedPattern = null;
    for (const line of codeownersLines) {
      if (!line.trim() || line.trim().startsWith("#")) {
        continue;
      }

      const pattern = line.trim().match(/^[^@]+/)[0].trim();
      const owners = line.trim().match(/@\S+/g);
      if (!pattern) {
        continue;
      }

      let globPattern = pattern;

      if (!pattern.startsWith('/') && !pattern.startsWith('*')) {
        globPattern = `{**/,}${pattern}`;
      }

      if (!path.extname(pattern) && !pattern.endsWith('*')) {
        globPattern = `${pattern}{/**,}`;
      }

      // Attempt match
      if (minimatch(normalizedFile, globPattern, { dot: true })) {
        // Continually overwrite owners, so that the last match wins
        matchedOwners = owners;
        lastMatchedPattern = globPattern;
      }
    }

    if (matchedOwners) {
      console.log(`Match found: File - ${changedFile}, Pattern - ${lastMatchedPattern}, Owner - ${matchedOwners}`);
      fileOwners[changedFile] = matchedOwners;
    }
  }

  const codeowners = {};
  for (const file in fileOwners) {
    const owners = fileOwners[file];
    updateCodeowners(owners)
  }

  return Object.keys(codeowners);

  function updateCodeowners(owners) {
    for (let owner of owners) {
      owner = owner.replace(/[<>\(\)\[\]\{\},;+*?=]/g, "");
      owner = owner.replace("@", "").split("/").pop();
      owner = owner.toLowerCase();
      if (!codeowners.hasOwnProperty(owner)) {
        codeowners[owner] = false;
      }
    }
  }
};

module.exports = { getCodeowners };
