export type GitlabUser = {
  id: number;
  username: string;
  name?: string;
};

export type GitlabMr = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: string;
  author: GitlabUser;
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  draft: boolean;
  work_in_progress: boolean;
  diff_refs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
  web_url: string;
  created_at: string;
  updated_at: string;
};

export type GitlabMrDiff = {
  old_path: string;
  new_path: string;
  a_mode: string;
  b_mode: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
};

export type GitlabMrChanges = {
  changes: GitlabMrDiff[];
  diff_refs: GitlabMr["diff_refs"];
};

export type GitlabNote = {
  id: number;
  type: string | null;
  body: string;
  author: GitlabUser;
  created_at: string;
  updated_at: string;
  system: boolean;
  noteable_id: number;
  noteable_iid: number;
  noteable_type: string;
  resolvable: boolean;
  resolved?: boolean;
  resolved_by?: GitlabUser | null;
};

export type GitlabDiscussion = {
  id: string;
  individual_note: boolean;
  notes: GitlabNote[];
};

export type GitlabAward = { id: number; name: string; user: GitlabUser };
export type GitlabProject = {
  id: number;
  default_branch: string;
  web_url: string;
};
export type GitlabBranch = {
  name: string;
  protected: boolean;
  can_push: boolean;
  commit: { id: string };
};
export type GitlabCommitAction = {
  action: "create" | "update" | "delete";
  file_path: string;
  content?: string;
  encoding?: "base64";
  last_commit_id?: string;
  execute_filemode?: boolean;
};

export type GitlabPosition = {
  base_sha: string;
  start_sha: string;
  head_sha: string;
  position_type: "text";
  new_path: string;
  new_line?: number;
  old_path?: string;
  old_line?: number;
  line_range?: {
    start: { line_code: string; type: "new" | "old" };
    end: { line_code: string; type: "new" | "old" };
  };
};
