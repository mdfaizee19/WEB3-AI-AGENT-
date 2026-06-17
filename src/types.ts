export interface ResearchTask {
  query: string;
  maxSources?: number;
}

export interface Finding {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface WebResearchResult {
  query: string;
  findings: Finding[];
  searchedAt: string;
}

export interface VerificationResult {
  url: string;
  isAccessible: boolean;
  statusCode?: number;
  error?: string;
}

export interface SourceVerificationInput {
  urls: string[];
}

export interface SourceVerificationResult {
  results: VerificationResult[];
  verifiedAt: string;
}

export interface SynthesisInput {
  task: ResearchTask;
  webResearch: WebResearchResult;
  verification: SourceVerificationResult;
}

export interface SynthesisResult {
  query: string;
  executiveSummary: string;
  keyFindings: string[];
  riskAssessment: string;
  recommendations: string[];
  confidenceScore: number; // 0-100
  verifiedSources: string[];
  unverifiedSources: string[];
  report: string; // full markdown report
  synthesizedAt: string;
}

export interface RiskAnalysisTask {
  address: string; // Ethereum wallet or contract address (0x...)
  chainId?: number; // default 1 (mainnet)
}

export interface RiskAnalysisResult {
  address: string;
  badge: 'SAFE' | 'CAUTION' | 'DANGEROUS';
  riskScore: number; // 0-100
  reasons: string[];
  report: string; // markdown
  analyzedAt: string;
}
