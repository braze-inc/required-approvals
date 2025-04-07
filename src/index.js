const { Octokit } = require("octokit");
const minimatch = require("minimatch").minimatch;
const process = require("process");
const path = require("path");
const fs = require("fs");

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
      reviewRequests(first:30) {
        nodes {
          asCodeOwner
          requestedReviewer {
            __typename
            ... on User {
              login
              name
            }
            ... on Team {
              name
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
`);
  return repository;
};

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
      const { baseRefName, headRefName, reviewRequests } = data.pullRequest;
      if (baseRefName !== "develop") {
        console.log("Skipping check because PR is not against develop branch");
      } else if (headRefName.startsWith("merge-release")) {
	console.log("Skipping check because this is a mergeback PR");
      } else {
        reviewRequests.nodes.forEach((request) => {
          if (request.asCodeOwner) {
	    // requestedReviewer is actually null since GITHUB_TOKEN doesn't have
            // permissions to read team data/names. For now, we can just not
            // include specific team names since they're listed on the PR anyway.
            outstandingCodeownerRequests.push("TEAM");
          }
        });
      }
    } catch (e) {
      console.log("There was an error parsing request data");
      console.log(e);
      console.log(JSON.stringify(data));
    }

    const requiredApprovals = outstandingCodeownerRequests.length === 0;
    let reason;
    if (requiredApprovals) {
      reason = "all codeowners have provided reviews";
    } else {
      reason = `codeowners ${outstandingCodeownerRequests.join(",")} have not provided reviews`;
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
