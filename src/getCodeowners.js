const minimatch = require("minimatch").minimatch;
const path = require("path");

function getCodeowners(codeownersFile, changedFiles) {
  const codeownersLines = codeownersFile.split("\n");
  const codeowners = {};
  for (const line of codeownersLines) {
    if (!line.trim() || line.startsWith("#")) {
      continue;
    }

    let [pattern, ...owners] = line.trim().split(/\s+/);

    if (pattern === '*') {
      updateCodeowners(owners);
    } else {
      if (!pattern.startsWith('/') && !pattern.startsWith('*')) {
        pattern = `{**/,}${pattern}`;
      }
      if (!path.extname(pattern) && !pattern.endsWith('*')) {
        pattern = `${pattern}{/**,}`;
      }
      for (let changedFile of changedFiles) {
        changedFile = `/${changedFile}`;
        if (minimatch(changedFile, pattern, { dot: true })) {
          console.log(`Match found: File - ${changedFile}, Pattern - ${pattern}`);
          updateCodeowners(owners);
        }
      }
    }
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
