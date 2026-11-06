export type ProjectFileList = {
  entries: { name: string; kind: 'directory' | 'file' }[];
  truncated: boolean;
};

export type ProjectFilePreview =
  | { kind: 'text'; content: string }
  | { kind: 'binary' | 'too-large' };
