/**
 * Entry point of the application
 */

const { getInput, setFailed, info } = require("@actions/core");
const { context, getOctokit } = require("@actions/github");
const OpenAI = require("openai");

/**
 * @typedef {Object} ActionInputs
 * @property {string} language - The language (defaults to "en")
 * @property {string} openaiApiKey - The OpenAI API key
 * @property {string} version - The release version
 * @property {string} [token] - The token (optional)
 */

/**
 * Parses the action inputs and returns an object with the parsed values.
 * @returns {ActionInputs} The parsed action inputs
 */
function parseInputs() {
  const openaiApiKey = getInput("openai-api-key");
  const language = getInput("language");
  const token = getInput("token");
  const version = getInput("version");

  return {
    language,
    openaiApiKey,
    token,
    version,
  };
}

/**
 * The main function that runs the action.
 */
async function run() {
  info("Running ai release notes action");
  const { openaiApiKey, language, token, version } = parseInputs();
  const octokit = getOctokit(token);

  if (context.eventName !== "pull_request") {
    throw new Error("This action can only be run on pull requests");
  }

  // Retrieve all commits from the PR
  const prNumber = context.payload.pull_request.number;
  const commits = octokit.rest.pulls.listCommits({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber,
  });

  // Read PR merged related commits and PR body

  try {
    // Get the release notes
    info(`OpenAI key: ${openaiApiKey.slice(0, 4)}...`);
    // Call the OpenAI API
    const openai = new OpenAI({
      apiKey: openaiApiKey,
    });

    const prompt =
      "You are a DEV OP enginner, your responsability is write changelog of the new software version." +
      "The changelog consist on useful information about the new features and bug fixes of the software." +
      "The changelog must be clear and concise, so the users can understand the changes." +
      "The changelog must be written in markdown format." +
      `The changelog must be written in [${language}].` +
      "The changelog must use words 'add' for features, changes, improvements, updates and 'fix' for hotfixes, fixes" +
      "The changelog must be written in the following structure" +
      "```markdown" +
      "## What's Changed" +
      "- Add new feature by @user" +
      "- Fix bug by @user" +
      "```" +
      "Do not ask for more information, use the following information to write the changelog." +
      "The following information that made in this version (commit message, author):" +
      `${JSON.stringify(
        commits.data.map((c) => ({
          message: c.commit.message,
          author: c.author.name,
          authorUrl: c.author.html_url,
        })),
        null,
        2
      )}`;

    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      model: "gpt-4o",
    });

    if (completion) {
      const response = completion.choices[0].message.content;
      info(`Response: ${response}`);

      // Create the release
      await octokit.rest.repos.createRelease({
        owner: context.repo.owner,
        repo: context.repo.repo,
        tag_name: version,
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
