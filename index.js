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
 * @property {string} [useMentionCommitsPrs] - Use mention commits and PRs (optional)
 */

/**
 * Parses the action inputs and returns an object with the parsed values.
 * @returns {ActionInputs} The parsed action inputs
 */
function parseInputs() {
  const openaiApiKey = getInput("openai-api-key");
  const language = getInput("language");
  const model = getInput("model") || "gpt-4o";
  const token = getInput("token");
  const version = getInput("version");
  const useGithubGeneratedNotes = getInput("use-github-generated-notes");
  const useMentionCommitsPrs = getInput("use-mention-commits-prs");

  return {
    language,
    model,
    openaiApiKey,
    token,
    version,
    useGithubGeneratedNotes,
    useMentionCommitsPrs,
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
    useMentionCommitsPrs,
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

    info(
      `Using context from ${
        useGithubGeneratedNotes ? "Github Notes" : "Commits"
      }`
    );

    let userPromptContext = "";
    if (useGithubGeneratedNotes) {
      try {
        let previousVersion;
        try {
          previousVersion = await octokit.rest.repos.getLatestRelease({
            owner: context.repo.owner,
            repo: context.repo.repo,
          });
        } catch (error) {
          info(`No previous version found: ${error.message}`);
        }

        const notes = await octokit.rest.repos.generateReleaseNotes({
          owner: context.repo.owner,
          repo: context.repo.repo,
          tag_name: version,
          target_commitish: context.sha,
          previous_tag_name: previousVersion?.data?.tag_name,
        });
        userPromptContext =
          "\nUse the following notes to write the release notes:\n" +
          `${JSON.stringify(notes.data.body, null, 2)}`;
      } catch (error) {
        info(`Failed to generate github notes: ${error.message}`);
      }
    } else {
      const commitData = await Promise.all(
        commits.data.map(async (c) => ({
          message: c.commit.message,
          author: c.author.name,
          authorUrl: c.author.html_url,
          prs: await getPRsFromCommit(octokit, c.sha),
        }))
      );

      userPromptContext =
        "\nUse the following commits data to write the release notes (commit message, author, PRs):" +
        `${JSON.stringify(commitData, null, 2)}`;
    }

    const prompt =
      "Your task is write release notes of a new version of the software following this rules:" +
      (useMentionCommitsPrs
        ? "\n - mention commits or PRs when possible and add a link in markdown format."
        : "\n - do not mention commits or PRs.") +
      "\n - do not add a mention to the user who made the changes." +
      "\n - notes must consist in useful information about the new features or bug fixes." +
      "\n - must be clear and concise." +
      "\n - group as features and fixes if possible." +
      "\n - must be organized with features first and then bug fixes." +
      `\n - must be written in the following language '${language}'.` +
      "\n - must be written in a friendly and professional tone." +
      "\n - must be exactly what the information provided says, without add up." +
      "\n - must be written user friendly." +
      "\n - must be written in a markdown format." +
      "\n - must have the following structure (do not add title, footer or any other content):" +
      "\n   ```" +
      "\n   ## Features" +
      "\n   * This is a feature" +
      "\n   ## Fixes" +
      "\n   * This is a fix";
    ("\n   ```");

    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content: prompt,
        },
        {
          role: "user",
          content: userPromptContext,
        },
      ],
      model: model,
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
    setFailed(
      `Error in run function: ${error.message || "Failed to run the action"}`
    );
  }
}

run();
