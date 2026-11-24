import { FolderStructure, ProblemMetadata } from '../storage/types';

type PathProblem = Pick<ProblemMetadata, 'id' | 'title' | 'difficulty' | 'language'>;

const EXTENSIONS: Record<string, string> = {
  'cpp': 'cpp', 'c++': 'cpp',
  'java': 'java',
  'python': 'py', 'python3': 'py', 'python 3': 'py',
  'javascript': 'js',
  'typescript': 'ts',
  'csharp': 'cs', 'c#': 'cs',
  'c': 'c',
  'ruby': 'rb',
  'swift': 'swift',
  'golang': 'go', 'go': 'go',
  'rust': 'rs',
  'kotlin': 'kt',
  'php': 'php',
  'scala': 'scala',
  'mysql': 'sql', 'mssql': 'sql', 'oraclesql': 'sql', 'sql': 'sql'
};

export function getExtensionByLanguage(language: string): string {
  return EXTENSIONS[language.toLowerCase()] || 'txt';
}

/** "0605-can-place-flowers" — used for filenames and the per-problem folder. */
export function problemSlug(problem: PathProblem): string {
  const paddedId = problem.id.toString().padStart(4, '0');
  const safeTitle = problem.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${paddedId}-${safeTitle}`;
}

/** Folder-safe language name: "Python3" -> "python3", "C++" -> "cpp", "C#" -> "csharp". */
export function languageFolder(language: string): string {
  const slug = language
    .toLowerCase()
    .replace(/\+/g, 'p')
    .replace(/#/g, 'sharp')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'other';
}

/** Folder holding the problem README and its language folders (nested layout only). */
export function problemDirectory(problem: PathProblem): string {
  return `${problem.difficulty}/${problemSlug(problem)}`;
}

export function usesProblemReadme(structure: FolderStructure | string): boolean {
  return structure === 'DifficultyProblemLanguage';
}

export function solutionFilename(
  problem: PathProblem,
  version: number,
  versionMode: 'versioned' | 'overwrite'
): string {
  const ext = getExtensionByLanguage(problem.language);
  const baseName = problemSlug(problem);
  return versionMode === 'versioned' ? `${baseName}_v${version}.${ext}` : `${baseName}.${ext}`;
}

export function solutionPath(
  problem: PathProblem,
  version: number,
  structure: FolderStructure | string,
  versionMode: 'versioned' | 'overwrite' = 'versioned'
): string {
  const filename = solutionFilename(problem, version, versionMode);

  switch (structure) {
    case 'DifficultyProblemLanguage':
      return `${problemDirectory(problem)}/${languageFolder(problem.language)}/${filename}`;
    case 'Language':
      return `${problem.language}/${filename}`;
    case 'Number':
      return `${problem.id.toString().padStart(4, '0')}/${filename}`;
    case 'Flat':
      return filename;
    case 'Difficulty':
    case 'Topic': // Topic folders not implemented upstream; falls back to Difficulty
    default:
      return `${problem.difficulty}/${filename}`;
  }
}
