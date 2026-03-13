import { useEffect, useState, useMemo } from 'react';
import { fetchPrsData, type PRData } from './api';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ComposedChart,
} from 'recharts';

interface UserStats {
  totalPRs: number;
  totalReviewComments: number; // unique PRs where they authored review comments OR regular comments
  totalCommentsOnTheirPRs: number; // unique PRs where someone commented on their PR
  prsWithOver10Comments: number; // PRs they created with >10 comments
  totalCommentsReceived: number; // total comments received on their PRs
}

type UserStatsDict = Record<string, UserStats>;

// List of bot usernames to exclude
const BOT_USERNAMES = new Set([
  'chatgpt-codex-connector',
  'cubic-dev-ai',
  'github-actions',
  'greptile-apps',
  'tests-posthog',
  'graphite-app',
  'copilot-pull-request-reviewer',
]);

interface TopUser {
  username: string;
  score: number;
  stats: UserStats;
}

function processPRData(prs: PRData[]): UserStatsDict {
  const stats: UserStatsDict = {};

  for (const pr of prs) {
    const author = pr.author?.login;
    if (!author) continue;

    // Initialize author stats if not exists
    if (!stats[author]) {
      stats[author] = {
        totalPRs: 0,
        totalReviewComments: 0,
        totalCommentsOnTheirPRs: 0,
        prsWithOver10Comments: 0,
        totalCommentsReceived: 0,
      };
    }

    // Count PRs they authored
    stats[author].totalPRs += 1;

    // Count total comments on this PR (from allComments and reviewThreads)
    const totalComments = 
      (pr.allComments?.length || 0) + 
      (pr.allReviewThreads?.reduce((sum, thread) => sum + (thread.comments?.length || 0), 0) || 0);

    // Track total comments received
    stats[author].totalCommentsReceived += totalComments;

    // Check if this PR has over 10 comments
    if (totalComments > 10) {
      stats[author].prsWithOver10Comments += 1;
    }

    // Track unique PRs where people commented on this author's PR
    // (only count once per PR, not per comment)
    if (totalComments > 0) {
      stats[author].totalCommentsOnTheirPRs += 1;
    }

    // Track people who commented on this PR (from both reviewThreads AND allComments)
    // Count unique PRs where each commenter commented (only once per PR per commenter)
    const commentersOnThisPR = new Set<string>();
    
    // Track review comments (from reviewThreads)
    if (pr.allReviewThreads) {
      for (const thread of pr.allReviewThreads) {
        if (thread.comments) {
          for (const comment of thread.comments) {
            const commenter = comment.authorLogin;
            if (commenter && commenter !== author) {
              commentersOnThisPR.add(commenter);
            }
          }
        }
      }
    }

    // Track regular comments (from allComments)
    if (pr.allComments) {
      for (const comment of pr.allComments) {
        const commenter = comment.authorLogin;
        if (commenter && commenter !== author) {
          commentersOnThisPR.add(commenter);
        }
      }
    }

    // Update stats for each commenter (only once per PR)
    for (const commenter of commentersOnThisPR) {
      if (!stats[commenter]) {
        stats[commenter] = {
          totalPRs: 0,
          totalReviewComments: 0,
          totalCommentsOnTheirPRs: 0,
          prsWithOver10Comments: 0,
          totalCommentsReceived: 0,
        };
      }
      stats[commenter].totalReviewComments += 1;
    }
  }

  return stats;
}

function calculateTopUsers(stats: UserStatsDict, topN: number = 5): TopUser[] {
  const usersWithScores: TopUser[] = [];

  for (const [username, userStats] of Object.entries(stats)) {
    // Skip bot accounts
    if (BOT_USERNAMES.has(username)) {
      continue;
    }

    // Calculate score: merged_PRs * 3 + review_comments * 2 + PRs_with_high_discussion * 3
    const score = 
      userStats.totalPRs * 3 +
      userStats.totalReviewComments * 2 +
      userStats.prsWithOver10Comments * 3;

    usersWithScores.push({
      username,
      score,
      stats: userStats,
    });
  }

  // Sort by score (descending) and return top N
  return usersWithScores
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

function App() {
  const [prsData, setPrsData] = useState<PRData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userStats, setUserStats] = useState<UserStatsDict>({});

  // Calculate top 5 users whenever userStats changes
  const topUsers = useMemo(() => {
    if (Object.keys(userStats).length === 0) return [];
    return calculateTopUsers(userStats, 5);
  }, [userStats]);

  // Calculate top 20 users for charts (excluding bots)
  const topUsersForCharts = useMemo(() => {
    if (Object.keys(userStats).length === 0) return [];
    return calculateTopUsers(userStats, 20);
  }, [userStats]);

  // Chart 1: Top engineers by score
  const chart1Data = useMemo(() => {
    return topUsersForCharts.map(user => ({
      engineer: user.username,
      score: user.score,
    }));
  }, [topUsersForCharts]);

  // Chart 2: Contribution breakdown (stacked bar chart)
  const chart2Data = useMemo(() => {
    return topUsersForCharts.map(user => ({
      engineer: user.username,
      'Merged PRs': user.stats.totalPRs * 3,
      'Review Comments': user.stats.totalReviewComments * 2,
      'High Discussion Bonus': user.stats.prsWithOver10Comments * 3,
      'Large PR Bonus': 0, // Placeholder - you may want to add this metric
    }));
  }, [topUsersForCharts]);

  // Chart 3: PR influence - avg comments per their PR
  const chart3Data = useMemo(() => {
    return topUsersForCharts
      .filter(user => user.stats.totalPRs > 0)
      .map(user => ({
        engineer: user.username,
        avgComments: Number((user.stats.totalCommentsReceived / user.stats.totalPRs).toFixed(2)),
      }))
      .sort((a, b) => b.avgComments - a.avgComments)
      .slice(0, 15);
  }, [topUsersForCharts]);

  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true);
        const data = await fetchPrsData();
        setPrsData(data);
        
        // Process the data and create the dictionary
        const stats = processPRData(data);
        setUserStats(stats);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    }
    
    loadData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-xl">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-500 text-xl">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-4 text-center">
          <h1 className="text-3xl font-bold text-gray-900">PostHog Contribution Metrics Dashboard</h1>
          <p className="text-gray-600 mt-1 text-sm">
            Last 90 days: 
            Total PRs: {prsData.length} | Total Contributors: {Object.keys(userStats).length}
          </p>
        </div>

        {/* Top 5 Leaderboard */}
        <div className="bg-white rounded-lg shadow-md p-4 mb-4 relative">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-bold text-gray-800">Top 5 Leaderboard</h2>
            <div className="relative group">
              <button className="w-5 h-5 rounded-full bg-gray-200 hover:bg-gray-300 flex items-center justify-center text-gray-600 hover:text-gray-800 transition-colors">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </button>
              {/* Popup Tooltip */}
              <div className="absolute right-0 top-8 w-64 p-4 bg-gray-900 text-white text-sm rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-10">
                <div className="font-semibold mb-2">Score Calculation Formula</div>
                <div className="space-y-1 text-gray-200">
                  <div>Score = (Merged PRs × 3) + (Review Comments × 2) + (High Discussion Bonus × 3)</div>
                  <div className="mt-2 pt-2 border-t border-gray-700">
                    <div className="text-xs text-gray-300">
                      <div>• Merged PRs: Each merged PR = 3 points</div>
                      <div>• Review Comments: Each unique PR reviewed = 2 points</div>
                      <div>• High Discussion: PRs with 10+ comments = 3 bonus points each</div>
                    </div>
                  </div>
                </div>
                {/* Arrow pointing up */}
                <div className="absolute -top-2 right-4 w-4 h-4 bg-gray-900 transform rotate-45"></div>
              </div>
            </div>
          </div>
          <div className="space-y-2">
            {topUsers.map((user, index) => (
              <div
                key={user.username}
                className="flex items-center justify-between p-3 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border border-blue-200"
              >
                <div className="flex items-center space-x-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-500 text-white font-bold text-sm">
                    {index + 1}
                  </div>
                  <div>
                    <div className="font-semibold text-base text-gray-800">{user.username}</div>
                    <div className="text-xs text-gray-600">
                      PRs: {user.stats.totalPRs} | Reviews: {user.stats.totalReviewComments} | 
                      High Discussion: {user.stats.prsWithOver10Comments}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold text-blue-600">Score: {user.score}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Charts Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {/* Chart 1: Top Engineers by Score */}
          <div className="bg-white rounded-lg shadow-md p-4">
            <h3 className="text-lg font-bold text-gray-800 mb-2">Top Engineers by Score</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chart1Data}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="engineer" 
                  angle={-45}
                  textAnchor="end"
                  height={80}
                  fontSize={10}
                />
                <YAxis fontSize={10} />
                <Tooltip />
                <Bar dataKey="score" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Chart 3: PR Influence - Avg Comments per PR */}
          <div className="bg-white rounded-lg shadow-md p-4">
            <h3 className="text-lg font-bold text-gray-800 mb-2">PR Influence (Avg Comments per PR)</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chart3Data}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="engineer" 
                  angle={-45}
                  textAnchor="end"
                  height={80}
                  fontSize={10}
                />
                <YAxis fontSize={10} />
                <Tooltip />
                <Bar dataKey="avgComments" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2: Contribution Breakdown (Full Width) */}
        <div className="bg-white rounded-lg shadow-md p-4">
          <h3 className="text-lg font-bold text-gray-800 mb-2">Contribution Breakdown</h3>
          <ResponsiveContainer width="100%" height={250}>
            <ComposedChart data={chart2Data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis 
                dataKey="engineer" 
                angle={-45}
                textAnchor="end"
                height={80}
                fontSize={10}
              />
              <YAxis fontSize={10} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Bar dataKey="Merged PRs" stackId="a" fill="#3b82f6" />
              <Bar dataKey="Review Comments" stackId="a" fill="#8b5cf6" />
              <Bar dataKey="High Discussion Bonus" stackId="a" fill="#f59e0b" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

export default App;