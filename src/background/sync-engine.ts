import { db } from '../storage/db';
import { ProblemMetadata, ProblemRecord } from '../storage/types';
import { GitHubClient, GitHubError } from '../github/client';
import { ReadmeGenerator } from '../github/readme-generator';
import { getExtensionByLanguage, problemDirectory, problemSlug, solutionPath, usesProblemReadme } from '../github/paths';

export class SyncEngine {
  /**
   * Send a message to the LeetCode page so the content script can render a toast.
   * When the originating tabId is known (initial sync) we target it directly;
   * otherwise (retry queue / alarm) we broadcast to any open LeetCode tabs.
   */
  private notifyTab(tabId: number | undefined, message: { type: string; payload?: any }): void {
    if (tabId !== undefined) {
      chrome.tabs.sendMessage(tabId, message).catch(() => {});
      return;
    }

    chrome.tabs.query({ url: 'https://leetcode.com/*' }, (tabs) => {
      for (const tab of tabs) {
        if (tab.id !== undefined) {
          chrome.tabs.sendMessage(tab.id, message).catch(() => {});
        }
      }
    });
  }

  /** Turn a raw error into a short, human-readable reason for the failure toast. */
  private humanizeError(error: any): string {
    if (error instanceof GitHubError) {
      switch (error.status) {
        case 401:
          return '401 Unauthorized — check your GitHub PAT';
        case 403:
          return '403 Forbidden — rate limit hit or missing repo permission';
        case 404:
          return '404 Not Found — repository or path does not exist';
        case 409:
          return '409 Conflict — file changed on GitHub, will retry';
        default:
          return error.message;
      }
    }
    return error?.message || 'Unknown network/API error';
  }

  /** File-safe slug used both for the target path and the success toast. */
  private buildSlug(problem: ProblemRecord): string {
    return problemSlug(problem);
  }

  private generateHeaderComment(problem: ProblemRecord): string {
    const ext = getExtensionByLanguage(problem.language);
    const dateStr = new Date(problem.submissionTime).toLocaleDateString();
    
    const lines = [
      `Problem: ${problem.title}`,
      `Difficulty: ${problem.difficulty}`,
      `Language: ${problem.language}`,
      `Date Solved: ${dateStr}`,
    ];
    if (problem.runtime) lines.push(`Runtime: ${problem.runtime}`);
    if (problem.memory) lines.push(`Memory: ${problem.memory}`);
    lines.push(`URL: ${problem.url}`);

    // Determine comment style based on extension
    if (['py', 'rb'].includes(ext)) {
      return lines.map(line => `# ${line}`).join('\n') + '\n\n';
    } else {
      return `/*\n${lines.map(line => ` * ${line}`).join('\n')}\n */\n\n`;
    }
  }

  private resolvePath(problem: ProblemRecord, version: number, structure: string, versionMode: 'versioned' | 'overwrite' = 'versioned'): string {
    return solutionPath(problem, version, structure, versionMode);
  }

  private async hash(text: string): Promise<string> {
    const msgUint8 = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  public async sync(problem: ProblemRecord, isRetry: boolean = false, tabId?: number) {
    try {
      if (!isRetry) {
        await db.pushToQueue({
          problem: problem,
          reason: 'Syncing to GitHub...',
          timestamp: Date.now(),
        });
      }

      const settings = await db.getSettings();
      
      const PAT = settings.pat;
      const REPO = settings.repository;
      const structure = settings.folderStructure;
      const versionMode = settings.versionMode;

      if (!PAT || !REPO) {
        console.error('[CommitCode] Sync failed: GitHub PAT or Repository not configured in Settings.');
        await db.pushToQueue({
          problem: problem,
          reason: 'GitHub PAT or Repository not configured',
          timestamp: Date.now(),
        });
        await db.addLogEntry({
          problemId: problem.id,
          title: problem.title,
          timestamp: Date.now(),
          status: 'failure',
          reason: 'GitHub PAT or Repository not configured'
        });
        this.notifyTab(tabId, {
          type: 'PUSH_FAILURE',
          payload: { slug: this.buildSlug(problem), error: 'GitHub PAT or Repository not configured' },
        });
        return;
      }

      // 2. Duplicate Detection
      const lastProblem = await db.getProblem(problem.id, problem.language);
      if (lastProblem && lastProblem.code) {
        const currentHash = await this.hash(problem.code);
        const lastHash = await this.hash(lastProblem.code);
        if (currentHash === lastHash) {
          console.log(`[CommitCode] Skipped sync for ${problem.id}: Code unchanged.`);
          await db.addLogEntry({
            problemId: problem.id,
            title: problem.title,
            timestamp: Date.now(),
            status: 'skipped',
            reason: 'Duplicate code'
          });
          await db.removeFromQueue(problem.id, problem.language);
          return;
        }
      }

      const client = new GitHubClient(PAT, REPO);

      // 3. Version suffixing & GitHub update logic
      let version = 1;
      let targetPath = '';

      if (versionMode === 'overwrite') {
        targetPath = this.resolvePath(problem, 1, structure, 'overwrite');
      } else {
        const v1Path = this.resolvePath(problem, 1, structure, 'versioned');
        const parts = v1Path.split('/');
        let directory = '';
        if (parts.length > 1) {
          directory = parts.slice(0, -1).join('/');
        }

        try {
          const files = await client.listDirectory(directory);
          const ext = getExtensionByLanguage(problem.language);
          const regex = new RegExp(`^${problemSlug(problem)}_v(\\d+)\\.${ext}$`);
          
          let maxVersion = 0;
          for (const file of files) {
            const match = file.name.match(regex);
            if (match) {
              const v = parseInt(match[1], 10);
              if (v > maxVersion) maxVersion = v;
            }
          }
          version = maxVersion + 1;
        } catch (e: any) {
          if (e.status !== 404) throw e;
        }
        targetPath = this.resolvePath(problem, version, structure, 'versioned');
      }

      // 4. Generate header comment and combine code
      const headerComment = this.generateHeaderComment(problem);
      const fullCode = headerComment + problem.code;
      
      let commitMsg = settings.commitTemplate;
      commitMsg = commitMsg.replace(/{title}/g, problem.title);
      commitMsg = commitMsg.replace(/{id}/g, problem.id);
      commitMsg = commitMsg.replace(/{difficulty}/g, problem.difficulty);
      commitMsg = commitMsg.replace(/{language}/g, problem.language);
      commitMsg = commitMsg.replace(/{runtime}/g, problem.runtime || 'N/A');
      commitMsg = commitMsg.replace(/{memory}/g, problem.memory || 'N/A');

      const filesToCommit = [
        { path: targetPath, content: fullCode }
      ];

      // 5. Remote Source of Truth & README Generation
      if (settings.readmeEnabled) {
        problem.version = version;
        
        let remoteMetadata: any[] = [];
        try {
          const remoteFile = await client.getFile('commitcode.json');
          // UTF-8 base64 decode
          const jsonStr = decodeURIComponent(escape(atob(remoteFile.content)));
          remoteMetadata = JSON.parse(jsonStr);
        } catch (e: any) {
          if (e.status !== 404) {
            console.warn('[CommitCode] Could not fetch commitcode.json, assuming new or missing.', e);
          }
        }

        // Migrate local data to remote if remote is empty
        if (remoteMetadata.length === 0) {
          const localProblems = await db.getAllProblems();
          remoteMetadata = localProblems.map(p => {
            const { code: _, ...rest } = p;
            return rest;
          });
        }

        // Include current problem, carrying its submission history forward
        const { code: _code, description: _description, ...currentMeta } = problem;
        const index = remoteMetadata.findIndex(p => p.id === currentMeta.id && p.language === currentMeta.language);
        const previousHistory = index >= 0 ? (remoteMetadata[index].history ?? []) : [];
        currentMeta.history = [
          ...previousHistory,
          {
            version,
            language: problem.language,
            runtime: problem.runtime,
            memory: problem.memory,
            submissionTime: problem.submissionTime,
            path: targetPath,
          },
        ];
        if (!currentMeta.tags?.length && index >= 0) currentMeta.tags = remoteMetadata[index].tags;
        if (index >= 0) {
          remoteMetadata[index] = currentMeta;
        } else {
          remoteMetadata.push(currentMeta);
        }

        // Queue commitcode.json
        const newJsonStr = JSON.stringify(remoteMetadata, null, 2);
        filesToCommit.push({ path: 'commitcode.json', content: newJsonStr });

        const readmeGenerator = new ReadmeGenerator();
        const readmeContent = readmeGenerator.generate(settings, remoteMetadata);
        if (readmeContent) {
          filesToCommit.push({ path: 'README.md', content: readmeContent });
        }

        // Per-problem README (nested layout): statement + every submission
        if (usesProblemReadme(structure)) {
          const problemReadmePath = `${problemDirectory(problem)}/README.md`;
          let description = problem.description || null;
          if (!description) {
            // Statement wasn't captured this time; keep the one already in the repo
            try {
              const existing = await client.getFile(problemReadmePath);
              description = ReadmeGenerator.extractDescription(decodeURIComponent(escape(atob(existing.content.replace(/\n/g, '')))));
            } catch (e: any) {
              if (e.status !== 404) console.warn('[CommitCode] Could not read existing problem README.', e);
            }
          }
          const entriesForProblem = (remoteMetadata as ProblemMetadata[]).filter(p => p.id === problem.id);
          filesToCommit.push({
            path: problemReadmePath,
            content: readmeGenerator.generateProblemReadme(entriesForProblem, description),
          });
        }
      }
      
      console.log(`[CommitCode] Batch committing ${filesToCommit.length} files...`);
      const commit = await client.commitFiles(filesToCommit, commitMsg);

      // 6. On success
      problem.version = version;
      const { description: _desc, ...toStore } = problem;
      await db.saveProblem(toStore);
      await db.addLogEntry({
        problemId: problem.id,
        title: problem.title,
        timestamp: Date.now(),
        status: 'success'
      });
      await db.removeFromQueue(problem.id, problem.language);
      console.log(`[CommitCode] Successfully synced ${problem.id} to GitHub.`);

      // Notify the LeetCode page so it can render a success toast.
      this.notifyTab(tabId, {
        type: 'PUSH_SUCCESS',
        payload: {
          slug: this.buildSlug(problem),
          repo: REPO,
          commitUrl: commit.htmlUrl,
        },
      });

    } catch (error: any) {
      console.error('[CommitCode] Sync failed:', error);
      const reason = this.humanizeError(error);

      // 7. On failure: push to retry queue
      if (!isRetry) {
        await db.pushToQueue({
          problem: problem,
          reason: reason,
          timestamp: Date.now(),
        });
      }

      await db.addLogEntry({
        problemId: problem.id,
        title: problem.title,
        timestamp: Date.now(),
        status: 'failure',
        reason: reason
      });

      // Notify the LeetCode page so it can render a failure toast.
      this.notifyTab(tabId, {
        type: 'PUSH_FAILURE',
        payload: { slug: this.buildSlug(problem), error: reason },
      });

      if (isRetry) {
        throw error; // Rethrow to let processRetryQueue handle attempts
      }
    }
  }

  public async processRetryQueue() {
    const queue = await db.getQueue();
    if (queue.length === 0) return;

    console.log(`[CommitCode] Processing ${queue.length} items in retry queue...`);
    const remainingQueue: typeof queue = [];
    
    for (const item of queue) {
      if (item.attempts >= 3) {
        console.warn(`[CommitCode] Problem ${item.problem.id} reached max retries. Dropping.`);
        continue;
      }

      try {
        await this.sync(item.problem, true);
        console.log(`[CommitCode] Successfully retried ${item.problem.id}.`);
      } catch (e: any) {
        console.warn(`[CommitCode] Retry failed for ${item.problem.id}.`);
        item.attempts += 1;
        item.timestamp = Date.now();
        item.reason = e.message || 'Retry failed';
        remainingQueue.push(item);
      }
    }

    await db.saveQueue(remainingQueue);
  }
}
