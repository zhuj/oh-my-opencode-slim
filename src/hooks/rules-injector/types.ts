export type RuleMetadata = {
  readonly alwaysApply?: boolean;
  readonly globs?: string | readonly string[];
  readonly paths?: string | readonly string[];
  readonly applyTo?: string | readonly string[];
};

export type RuleCandidate = {
  readonly path: string;
  readonly realPath: string;
  readonly relativePath: string;
  readonly body: string;
  readonly contentHash: string;
  readonly metadata: RuleMetadata;
  readonly prefixIndex: number;
  readonly depth: number;
  readonly global: boolean;
};

export type MatchedRule = RuleCandidate & {
  readonly reason: string;
};
