// weave_frontend/src/api.ts

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export interface PRData {
  number: number;
  mergedAt: string;
  author: {
    login: string;
  };
  changedFiles: number;
  allComments: Array<{ authorLogin: string | null }>;
  allReviewThreads: Array<{
    isResolved: boolean;
    comments: Array<{ authorLogin: string | null }>;
  }>;
}

/**
 * Fetches the PR data from the backend
 * @returns {Promise<PRData[]>} Array of PR data
 */
export async function fetchPrsData(): Promise<PRData[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/prs`);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching PRs data:', error);
    throw error;
  }
}