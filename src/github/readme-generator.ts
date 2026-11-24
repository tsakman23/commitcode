import { ProblemMetadata, Settings, SubmissionEntry } from '../storage/types';
import { problemDirectory, solutionPath } from './paths';

export const DESCRIPTION_START = '<!-- commitcode:description:start -->';
export const DESCRIPTION_END = '<!-- commitcode:description:end -->';

export class ReadmeGenerator {
  private resolvePath(problem: ProblemMetadata, settings: Settings): string {
    return solutionPath(problem, problem.version || 1, settings.folderStructure, settings.versionMode);
  }

  public generate(settings: Settings, allProblems: ProblemMetadata[]): string {
    if (allProblems.length === 0) return '';

    let total = 0;
    let easy = 0;
    let medium = 0;
    let hard = 0;

    // Deduplicate by ID to get unique problems solved count
    const uniqueIds = new Set<string>();

    // Sort problems by ID
    const sorted = [...allProblems].sort((a, b) => {
      const idA = parseInt(a.id) || 0;
      const idB = parseInt(b.id) || 0;
      return idA - idB;
    });

    const rows: string[] = [];

    for (const p of sorted) {
      // Only count difficulty once per problem ID
      if (!uniqueIds.has(p.id)) {
        uniqueIds.add(p.id);
        if (p.difficulty === 'Easy') easy++;
        else if (p.difficulty === 'Medium') medium++;
        else if (p.difficulty === 'Hard') hard++;
      }

      const dateStr = new Date(p.submissionTime).toLocaleDateString();
      const path = this.resolvePath(p, settings);

      // Encode path for markdown link
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');

      rows.push(`| ${p.id} | [${p.title}](${p.url}) | ${p.difficulty} | [${p.language}](./${encodedPath}) | ${dateStr} |`);
    }

    total = uniqueIds.size;

    const now = new Date();
    const month = now.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const day = now.toLocaleString('en-US', { day: 'numeric', timeZone: 'UTC' });
    const year = now.toLocaleString('en-US', { year: 'numeric', timeZone: 'UTC' });
    const time = now.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });

    const lastUpdated = `Last synced • ${month} ${day}, ${year} • ${time} UTC`;

    const markdown = `# LeetCode Solutions

Automatically synced by [CommitCode](https://github.com/jaiswalism/CommitCode) 

<div align="center">
  <img src="https://img.shields.io/badge/Total_Solved-${total}-blue?style=for-the-badge&logo=leetcode" alt="Total Solved" />
  <img src="https://img.shields.io/badge/Easy-${easy}-brightgreen?style=for-the-badge" alt="Easy" />
  <img src="https://img.shields.io/badge/Medium-${medium}-yellow?style=for-the-badge" alt="Medium" />
  <img src="https://img.shields.io/badge/Hard-${hard}-red?style=for-the-badge" alt="Hard" />
</div>

<div align="center">
  <i>${lastUpdated}</i>
</div>

---

## Solutions
| # | Problem | Difficulty | Language | Date |
|---|---------|------------|----------|------|
${rows.join('\n')}
`;

    return markdown;
  }

  /**
   * README.md that sits in a problem's own folder (nested layout):
   * title, difficulty, topics, problem statement, and a table of every submission.
   *
   * @param entries every metadata entry for this problem id (one per language)
   * @param description problem statement HTML; when missing, pass the previous one
   */
  public generateProblemReadme(entries: ProblemMetadata[], description: string | null): string {
    const head = entries[0];
    const dir = problemDirectory(head);

    const submissions: SubmissionEntry[] = entries
      .flatMap(e => e.history ?? [])
      .sort((a, b) => a.submissionTime - b.submissionTime);

    const tags = Array.from(new Set(entries.flatMap(e => e.tags ?? [])));
    const meta = [`**Difficulty:** ${head.difficulty}`];
    if (tags.length) meta.push(`**Topics:** ${tags.join(', ')}`);

    const rows = submissions.map(s => {
      const rel = s.path.startsWith(`${dir}/`) ? s.path.slice(dir.length + 1) : s.path;
      const link = rel.split('/').map(encodeURIComponent).join('/');
      const date = new Date(s.submissionTime).toISOString().slice(0, 10);
      return `| [v${s.version}](./${link}) | ${s.language} | ${s.runtime || 'N/A'} | ${s.memory || 'N/A'} | ${date} |`;
    });

    return `# [${head.id}. ${head.title}](${head.url})

${meta.join(' · ')}

${DESCRIPTION_START}
${description ?? '_Problem statement not captured._'}
${DESCRIPTION_END}

## Submissions

| Version | Language | Runtime | Memory | Date |
|---------|----------|---------|--------|------|
${rows.join('\n')}
`;
  }

  /** Pull the problem statement back out of an existing problem README. */
  public static extractDescription(readme: string): string | null {
    const start = readme.indexOf(DESCRIPTION_START);
    const end = readme.indexOf(DESCRIPTION_END);
    if (start === -1 || end === -1 || end < start) return null;
    const body = readme.slice(start + DESCRIPTION_START.length, end).trim();
    return body && body !== '_Problem statement not captured._' ? body : null;
  }
}
