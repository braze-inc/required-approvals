const { Octokit } = require("octokit");
const OctokitRest = require("@octokit/rest");
const minimatch = require("minimatch").minimatch;
const process = require("process");
const path = require("path");
const fs = require("fs");

let cachedCodeowners = null;
async function getRateLimit(octokit) {
  const { rateLimit } = await octokit.graphql(`
    query {
      rateLimit {
        limit
        cost
        remaining
        resetAt
      }
    }
  `);
  return rateLimit;
}

// Cached according to YYYY-MM-DD to reduce network calls
// Get all teams/users in the org
async function getTeamDirectory(octokit) {
  try {
    const cachedDirectory = fs.readFileSync("teamdirectory").toString();
    const { timestamp, userDirectory } = JSON.parse(cachedDirectory.toString());
    const today = (new Date().toISOString().substring(0, 10));
    if (timestamp === today) {
      console.log("Using cached directory");
      return userDirectory;
    }
  } catch(e) {
    console.log("Error reading cached user directory");
    console.log(e);
  }

  console.log("Updating team directory");

  const { organization } = await octokit.graphql.paginate(`
    query($cursor: String) {
      organization(login: "Appboy") {
        teams(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            slug
            name
            members(first: 100) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                login
                name
              }
            }
          }
        }
      }
    }
  `);

  // We need a reverse directory -- users to teams, so that we can compare the review objects
  const userDirectory = {};
  organization.teams.nodes.forEach((team) => {
    team.members.nodes.forEach(({ login }) => {
      if (!userDirectory[login]) {
        userDirectory[login] = [];
      }

      userDirectory[login].push(team.slug);
    });
  });

  fs.writeFileSync(
    "teamdirectory",
    JSON.stringify({ userDirectory, timestamp: (new Date()).toISOString().substring(0, 10) }),
  );

  return userDirectory;
}

const updateCodeownersCache = async (octokit) => {
  console.log("Pulling down codeowners");
  const { data } = await octokit.repos.getContent({
    owner: "Appboy",
    repo: "platform",
    path: ".github/CODEOWNERS",
    ref: "develop",
    headers: {
      // Raw media type necessary for files over 1MB
      accept: "application/vnd.github.v3.raw",
    }
  });
  cachedCodeowners = data;
  console.log("Done pulling down codeowners");
  return data;
};

const getCodeowners = async (prNumber, changedFiles) => {
  console.log("Processing PR #" + prNumber);
  const codeownersContent = cachedCodeowners;

  if (!codeownersContent) {
    console.info("No CODEOWNERS file found");
    process.exit(1);
  }

  const codeownersLines = codeownersContent.split("\n");
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
        // console.log(changedFile)
        if (minimatch(changedFile, pattern, { dot: true })) {
          // console.log(`Match found: File - ${changedFile}, Pattern - ${pattern}`);
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

async function getNewestPRNumberByBranch(octokit, branchName, repo) {
    const pullRequests = await octokit.paginate(
        octokit.pulls.list,
        {
            owner: repo.owner.login,
            repo: repo.name,
            state: "all",
            head: `${repo.owner.login}:${branchName}`,
        },
        (response) => response.data
    );

    if (pullRequests.length === 0) {
        console.info(`No PRs found for branch ${branchName}`);
        process.exit(1);
    }

    pullRequests.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const newestPR = pullRequests[0].number;
    return newestPR;
}

const getRecentPullRequests = async (octokit) => {
  const { repository } = await octokit.graphql(`
query() {
  repository(owner: "Appboy", name: "platform") {
    pullRequests(baseRefName:"develop", states: [MERGED], first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
      edges {
        node {
          title
          number
          isDraft
          createdAt
          files(first:100) {
            nodes {
              path
            }
          }
          author {
            login
            ... on User {
              name
            }
          }
        }
      }
    }
  }
}
`);
  return repository;
};

const getGraphqlData = async (octokit, prNumber) => {
const { repository } = await octokit.graphql(`
query() {
  repository(owner: "Appboy", name: "platform") {
    pullRequest(number: ${prNumber}) {
      title
      number
      isDraft
      createdAt
      baseRefName
      headRefName
      files(first:100) {
        nodes {
          path
        }
      }
      timeline(last:100) {
        nodes {
          ... on ReviewRequestedEvent {
            __typename
            createdAt
            requestedReviewer {
              ...ReviewerInfo
            }
          }
          ... on ReviewRequestRemovedEvent {
            __typename
            createdAt
            requestedReviewer {
              ...ReviewerInfo
            }
          }
          ... on PullRequestReview {
            __typename
            state
            submittedAt
            author {
              login
            }
          }
        }
      }
      author {
        login
        ... on User {
          name
        }
      }
    }
  }
}

fragment ReviewerInfo on RequestedReviewer {
  ... on User {
    login
  }
  ... on Team {
    name
  }
}
`);
  return repository;
};

// There are 2 API requests
// (the user directory / team mapping is omitted, because it is cached once per day)
// 1 to get PR data, including timeline events and files changed
// 1 to get the most recent CODEOWNERS file contents



async function main() {
    const token = process.env["INPUT_TOKEN"];
    const orgName = process.env["INPUT_ORG_NAME"];
    const minApprovals = parseInt(process.env["INPUT_MIN_APPROVALS"], 10);
    const requireAllApprovalsLatestCommit =
        process.env["INPUT_REQUIRE_ALL_APPROVALS_LATEST_COMMIT"];
    const ghRef = process.env["GITHUB_REF"];
    const ghRepo = process.env["GITHUB_REPOSITORY"];
    const approvalMode = process.env["INPUT_APPROVAL_MODE"];

    const octokit = new Octokit({ auth: token });
    const octokitRest = new OctokitRest.Octokit({ auth: token });

    const [owner, repoName] = ghRepo.split("/");

    await updateCodeownersCache(octokitRest);
    const { pullRequests } = await getRecentPullRequests(octokit);
    console.log("Got recent pullRequests: ", pullRequests);
    const prData = {};
    pullRequests.edges.forEach(async ({ node }) => {
      const prNumber = node.number;
      const filesChanged = node.files.nodes.map(({ path }) => path);
      const requiredCodeowners = await getCodeowners(prNumber, filesChanged);
      prData[prNumber] = { numCodeowners: requiredCodeowners.length, codeowners: requiredCodeowners };
      if (prNumber === pullRequests.edges[pullRequests.edges.length - 1].node.number) {
        let maxCodeowners = 0;
        Object.keys(prData).forEach((num) => {
          if (prData[num].numCodeowners > maxCodeowners) {
            maxCodeowners = prData[num].numCodeowners;
          }
        });

        for (let i = maxCodeowners; i > 1; i--) {
          console.log(`PRs with ${i} teams:`);
          Object.keys(prData).forEach((num) => {
            const pr = prData[num];
            if (pr.numCodeowners === i) {
              console.log(`#${num}: ${pr.codeowners}`);
            }
          });
        }
      }
    });


    return;

    let prNumber;
    if (process.env["INPUT_PR_NUMBER"] && process.env["INPUT_PR_NUMBER"] !== "") {
        prNumber = parseInt(process.env["INPUT_PR_NUMBER"], 10);
    } else if (process.env["INPUT_BRANCH"] && process.env["INPUT_BRANCH"] !== "") {
        prNumber = await getNewestPRNumberByBranch(octokit, process.env["INPUT_BRANCH"], repo.data);
    } else {
        const ghRefParts = ghRef.split("/");
        prNumber = parseInt(ghRefParts[ghRefParts.length - 2], 10);
    }

    const data = await getGraphqlData(octokit, prNumber);

    const outstandingCodeownerRequests = [];
    try {
      const { baseRefName, headRefName, timeline } = data.pullRequest;
      if (baseRefName !== "develop") {
        console.log("Skipping check because PR is not against develop branch");
        process.exit(0);
      }
      
      if (headRefName.startsWith("merge-release")) {
	      console.log("Skipping check because this is a mergeback PR");
        process.exit(0);
      }
      
      const requiredCodeowners = await getCodeowners(prNumber, data.pullRequest.files.nodes.map(({ path }) => path));
      console.info(`Required codeowners: ${requiredCodeowners.join(', ')}`);
      const userDirectory = await getTeamDirectory(octokit);
      const approvals = timeline.nodes.filter(({ state }) => state === "APPROVED");
  
      // Get the teams associated with all users who have provided an approval
      const approvingUsers = approvals.map(({ author }) => author.login);
      const approvedTeams = [];
      approvingUsers.forEach((user) => {
        approvedTeams.push(...userDirectory[user]);
      });
  
      requiredCodeowners.forEach((owner) => {
        if (!approvedTeams.includes(owner)) {
          outstandingCodeownerRequests.push(owner);
        };
      });
    } catch (e) {
      console.log("There was an error parsing request data");
      console.log(e);
      console.log(JSON.stringify(data));
    }

    const rateLimitData = await getRateLimit(octokit);
    console.log(rateLimitData);
    const requiredApprovals = outstandingCodeownerRequests.length === 0;
    let reason;
    if (requiredApprovals) {
      reason = "all codeowners have provided reviews";
    } else {
      reason = `codeowners ${outstandingCodeownerRequests.join(", ")} have not provided reviews`;
    }

    const outputPath = process.env["GITHUB_OUTPUT"];
    fs.appendFileSync(outputPath, `approved=${requiredApprovals.toString().toLowerCase()}`);

    if (requiredApprovals) {
        console.info(`Required approvals met: ${reason}`);
        process.exit(0);
    } else {
        console.warn(`Required approvals not met: ${reason}`);
	console.warn("This GitHub action can't see which particular teams are missing.");
	console.warn("Refer to the PR reviewers list in GitHub for this information.");
        process.exit(1);
    }

}

main();
