const { Octokit } = require("octokit");
const OctokitRest = require("@octokit/rest");
const process = require("process");
const fs = require("fs");
const { getCodeowners } = require("./getCodeowners.js");

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
    // Silencing these errors. Caching won't work in production because this runs in a VM.
    /*
    console.log("Error reading cached user directory");
    console.log(e);
    */
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

const getCodeownersData = async (octokit, changedFiles) => {
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

  const codeownersContent = data;

  if (!codeownersContent) {
    console.info("No CODEOWNERS file found");
    process.exit(1);
  }

  return getCodeowners(codeownersContent, changedFiles);
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

const getGraphqlData = async (octokit, prNumber) => {
  const { repository } = await octokit.graphql.paginate(`
query($cursor: String) {
  repository(owner: "Appboy", name: "platform") {
    pullRequest(number: ${prNumber}) {
      title
      number
      isDraft
      createdAt
      baseRefName
      headRefName
      files(first:100, after: $cursor) {
        nodes {
          path
        }
        pageInfo {
          endCursor
          hasNextPage
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

// There are 3 API requests
// 1 for the user directory / team mapping
//   Caching is a noop now because this runs in a VM, but we could sync teams over
//   to ClickHouse or some other remote store, if we want to later on.
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

      const requiredCodeowners = await getCodeownersData(octokitRest, data.pullRequest.files.nodes.map(({ path }) => path));
      console.info(`Required codeowners: ${requiredCodeowners.join(', ')}`);
      const userDirectory = await getTeamDirectory(octokit);
      const approvals = timeline.nodes.filter(({ state }) => state === "APPROVED");
  
      // Get the teams associated with all users who have provided an approval
      const approvingUsers = approvals.map(({ author }) => author.login);
      const approvedTeams = [];
      approvingUsers.forEach((user) => {
        // We must check userDirectory first, because users who are on the timeline
        // may have been removed from the org
        if (userDirectory[user]) {
          approvedTeams.push(...userDirectory[user]);
          // Push user onto approved teams as well, to account for any files owned by individuals
          approvedTeams.push(user)
        }
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
    let teams = "";
    if (requiredApprovals) {
      reason = "all codeowners have provided reviews";
    } else {
      teams = outstandingCodeownerRequests.join(", ");
      reason = `codeowners ${teams} have not provided reviews`;
    }

    const outputPath = process.env["GITHUB_OUTPUT"];
    fs.appendFileSync(outputPath, `teams=${teams}`);

    if (requiredApprovals) {
        console.info(`Required approvals met: ${reason}`);
        process.exit(0);
    } else {
        console.warn(`Required approvals not met: ${reason}`);
        process.exit(1);
    }

}

main();
