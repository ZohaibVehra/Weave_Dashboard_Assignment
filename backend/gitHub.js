import dotenv from "dotenv";
import { writeFile } from "fs/promises";

dotenv.config();

const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

const POSTHOG_PR_DETAILS_QUERY = `
  query PosthogPrDetails($cursor: String) {
    repository(owner: "PostHog", name: "posthog") {
      pullRequests(
        first: 100
        states: MERGED
        orderBy: { field: UPDATED_AT, direction: DESC }
        after: $cursor
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          mergedAt
          author {
            login
          }
          changedFiles
          reviewThreads(first: 15) {
            totalCount
            nodes {
              isResolved
              comments(first: 15) {
                nodes {
                  author {
                    login
                  }
                }
              }
            }
          }
          comments(first: 15) {
            totalCount
            nodes {
              author {
                login
              }
            }
          }
        }
      }
    }
  }
`;

// Small helper to pause between page requests to avoid secondary rate limits
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple call to GitHub's GraphQL API to fetch PR details for PostHog/posthog.
 *
 * For each of the most recent merged PRs, this returns:
 * - mergedAt
 * - author login
 * - number of file changes (changedFiles)
 * - number of review comments (reviewThreads.totalCount)
 * - for each (issue) comment on the PR, the comment author login
 *
 * Requires a GitHub personal access token exposed as:
 * VITE_TOKEN=ghp_...
 * in a .env/.env.local file at the project root.
 */
export async function pullRepoInfo(daysBack) {
  const token = process.env.TOKEN;

  if (!token) {
    console.error(
      "TOKEN is not set. Add it to your .env file at the project root."
    );
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  let cursor = null;
  const allPrs = [];

  try {
    while (true) {
      const response = await fetch(GITHUB_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: POSTHOG_PR_DETAILS_QUERY,
          variables: {
            cursor,
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(
          "GitHub GraphQL request failed:",
          response.status,
          response.statusText,
          text
        );
        return;
      }

      const json = await response.json();
      console.log("GitHub GraphQL raw response (PR page):", json);

      const connection = json && json.data && json.data.repository
        ? json.data.repository.pullRequests
        : null;

      if (!connection) {
        break;
      }

      const pagePrs = connection.nodes || [];
      allPrs.push(...pagePrs);

      // Because results are ordered by UPDATED_AT DESC,
      // once the oldest PR in this page is older than cutoff,
      // all subsequent pages will also be older and can be skipped.
      const oldestOnPage = pagePrs[pagePrs.length - 1];
      if (oldestOnPage && oldestOnPage.mergedAt) {
        const mergedAtDate = new Date(oldestOnPage.mergedAt);
        if (mergedAtDate < cutoff) {
          break;
        }
      }

      if (!connection.pageInfo || !connection.pageInfo.hasNextPage) {
        break;
      }

      cursor = connection.pageInfo.endCursor;

      // Be nice to GitHub: wait a bit between paginated requests
      await sleep(1000);
    }

    const filteredPrs = allPrs.filter((pr) => {
      if (!pr || !pr.mergedAt) return false;
      const mergedAtDate = new Date(pr.mergedAt);
      return mergedAtDate >= cutoff;
    });

    console.log(
      "Mapped PR details (after pagination + date filter):",
      filteredPrs
    );

    return filteredPrs;
  } catch (error) {
    console.error("Error calling GitHub GraphQL API:", error);
  }
}

/**
 * Convenience helper that:
 * 1) fetches recent merged PRs (with pagination over PRs only)
 * 2) for each PR, maps the first page of comments & reviewThreads into flat arrays
 *
 * Returns an array of PRs where each item includes:
 * - basic PR info from `pullRepoInfo`
 * - `allComments`: first-page list of comments with authors
 * - `allReviewThreads`: first-page list of review threads with their comments
 */
export async function fetchPrsWithAllComments(daysBack) {
  const prs = await pullRepoInfo(daysBack);
  if (!Array.isArray(prs)) return [];

  const enriched = await Promise.all(
    prs.map(async (pr) => {
      const initialComments = (pr.comments && pr.comments.nodes) || [];
      const allComments = initialComments.map((node) => ({
        authorLogin: node && node.author ? node.author.login : null,
      }));

      const initialThreads = (pr.reviewThreads && pr.reviewThreads.nodes) || [];
      const allReviewThreads = initialThreads.map((thread) => ({
        isResolved: Boolean(thread && thread.isResolved),
        comments:
          (thread &&
            thread.comments &&
            Array.isArray(thread.comments.nodes) &&
            thread.comments.nodes.map((c) => ({
              authorLogin: c && c.author ? c.author.login : null,
            }))) ||
          [],
      }));

      return {
        ...pr,
        allComments,
        allReviewThreads,
      };
    })
  );

  console.log("PRs with all comments:", enriched);
  return enriched;
}

/**
 * Helper to fetch full data for the last 90 days.
 *
 * This is intended to be called from a Node script (not the browser) that can
 * then write the returned data to a JSON file on disk for your app to consume.
 */
export async function fetchLast90DaysPrsWithAllComments() {
  const NINETY_DAYS = 90;
  const data = await fetchPrsWithAllComments(NINETY_DAYS);
  console.log(
    `Fetched ${Array.isArray(data) ? data.length : 0} PRs for last 90 days`
  );
  return data;
}

/**
 * Stores the last 90 days of PR data into a local JSON file.
 * Outputs: `prs_last_90_days.json` in the current working directory.
 */
export async function saveLast90DaysPrsToJson() {
  const data = await fetchLast90DaysPrsWithAllComments();

  const json = JSON.stringify(data, null, 2);

  // You can change this path if you want the JSON in a specific folder
  await writeFile("prs_last_90_days.json", json, "utf8");

  console.log("Saved PR data to prs_last_90_days.json");
}

/**
 * Convenience helper to fetch data just for the last N hours.
 *
 * This uses the same logic as `fetchPrsWithAllComments`, but:
 * - bounds the search window to 1 day on the API side
 * - then filters locally to only keep PRs merged within the last `hoursBack`.
 */
export async function fetchLastHoursPrsWithAllComments() {
  const ONE_DAY = 1
  const prs = await fetchPrsWithAllComments(ONE_DAY)

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const filtered = prs.filter((pr) => {
    if (!pr || !pr.mergedAt) return false
    const mergedAtDate = new Date(pr.mergedAt)
    return mergedAtDate >= cutoff
  })

  console.log(
    "PR data (including comments & review threads) for last 24 hours:",
    filtered
  )

  return filtered
}

export async function update90DayJsonWithLatestDay() {
  const FILE = "prs_last_90_days.json"

  const existingRaw = await readFile(FILE, "utf8")
  const existing = JSON.parse(existingRaw)

  const latestDay = await fetchLastHoursPrsWithAllComments()

  const combined = [...existing, ...latestDay]

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 90)

  const filtered = combined.filter((pr) => {
    if (!pr?.mergedAt) return false
    return new Date(pr.mergedAt) >= cutoff
  })

  await writeFile(FILE, JSON.stringify(filtered, null, 2), "utf8")

  console.log("90-day JSON updated. Oldest data removed, newest PRs added.")
}

saveLast90DaysPrsToJson()