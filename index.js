const { getInput, setFailed, info } = require("@actions/core");
const { context, getOctokit } = require("@actions/github");
const OpenAI = require("openai");

/**
 * @typedef {Object} ActionInputs
 * @property {string} language - The language (defaults to "en")
 * @property {string} [model] - The model (defaults to "gpt-4o")
 * @property {string} openaiApiKey - The OpenAI API key
 * @property {string} version - The release version
 * @property {string} [token] - The token (optional)
 * @property {string} [useGithubGeneratedNotes] - Use Github generated notes (optional)
 */

/**
 * Parses the action inputs and returns an object with the parsed values.
 * @returns {ActionInputs} The parsed action inputs
 */
function parseInputs() {
  const openaiApiKey = getInput("openai-api-key");
  const language = getInput("language");
  const model = getInput("model");
  const token = getInput("token");
  const version = getInput("version");
  const useGithubGeneratedNotes = getInput("use-github-generated-notes");

  return {
    language,
    model,
    openaiApiKey,
    token,
    version,
    useGithubGeneratedNotes,
  };
}

/**
 * Function to get PRs associated with a commit.
 * @param {string} octokit - The octokit instance
 * @param {string} sha - The commit SHA
 * @returns {Array<{label: string, url: string}[]>} The PRs associated with the commit
 */
async function getPRsFromCommit(octokit, sha) {
  const pr = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
    owner: context.repo.owner,
    repo: context.repo.repo,
    commit_sha: sha,
  });

  return pr.data.map((p) => ({
    label: `#${p.number}`,
    url: p.html_url,
  }));
}

/**
 * The main function that runs the action.
 */
async function run() {
  info("Running ai release notes action");
  const {
    openaiApiKey,
    language,
    model,
    token,
    version,
    useGithubGeneratedNotes,
  } = parseInputs();
  const octokit = getOctokit(token);

  if (context.eventName !== "pull_request") {
    throw new Error("This action can only be run on pull requests");
  }

  // Retrieve all commits from the PR
  const prNumber = context.payload.pull_request.number;
  const commits = await octokit.rest.pulls.listCommits({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber,
  });

  if (!commits.data.length) {
    throw new Error("No commits found in the pull request");
  }

  try {
    // Get the release notes
    info(`OpenAI key: ${openaiApiKey.slice(0, 6)}...`);
    // Call the OpenAI API
    const openai = new OpenAI({
      apiKey: openaiApiKey,
    });

    let githubNotesContext = "";
    if (useGithubGeneratedNotes) {
      try {
        const previousVersion = await octokit.rest.repos.getLatestRelease({
          owner: context.repo.owner,
          repo: context.repo.repo,
        });
        const notes = await octokit.rest.repos.generateReleaseNotes({
          owner: context.repo.owner,
          repo: context.repo.repo,
          tag_name: version,
          target_commitish: context.sha,
          previous_tag_name: previousVersion,
        });
        githubNotesContext =
          "\nFor more context use Github auto generated log also as context, avoid repeating with commits data:\n" +
          `${JSON.stringify(notes, null, 2)}`;
      } catch (error) {
        info("Failed to generate github notes", error);
      }
    }

    const prompt =
      "You are a DEV OPS engineer, your responsibility is write changelog of the new software version." +
      "The changelog consist on useful information about the new features and bug fixes of the software." +
      "The changelog must be clear and concise, so the users can understand the changes." +
      "The changelog must use words 'add' for features, changes, improvements, updates and 'fix' for hot-fixes, bugfix" +
      "The changelog must be organized with features first and then bug fixes." +
      "The changelog must be written in the following structure:\n" +
      "```\n" +
      "## What's Changed" +
      "- Add new feature" +
      "- Fix bug" +
      "```" +
      "\nDo not ask for more information." +
      "\nUse only the following commits data to write the changelog (commit message, author, PRs):" +
      `${JSON.stringify(
        commits.data.map((c) => ({
          message: c.commit.message,
          author: c.author.name,
          authorUrl: c.author.html_url,
          prs: getPRsFromCommit(octokit, c.sha),
        })),
        null,
        2
      )}` +
      githubNotesContext +
      `\nThe changelog must be written in the following language '${language}'. Translate everything to this language.`;

    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      model: model || "gpt-4o",
    });

    if (completion) {
      const response = completion.choices[0].message.content;
      // Create the release
      await octokit.rest.repos.createRelease({
        owner: context.repo.owner,
        repo: context.repo.repo,
        tag_name: version,
        name: version,
        body: response,
      });
    } else {
      throw new Error("Failed to generate release notes");
    }
    // Create a comment on the pull request
  } catch (error) {
    setFailed(error.message || "Failed to run the action");
  }
}

run();
