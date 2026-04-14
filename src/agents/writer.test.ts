import { describe, it, expect } from 'bun:test';
import { WriterAgent } from './writer.js';
import type { ContextAgentOutput } from '../types.js';
import type { LLMProvider } from '../providers/llm.js';

function makeContext(): ContextAgentOutput {
  return {
    contentType: 'how-to',
    triggerFacts: [],
    cluster: {
      argocdApps: [],
      recentEvents: [],
      recentDeploys: [],
      clusterHealth: null,
      timestamp: new Date().toISOString(),
    },
    additionalContext: {},
    historicalContext: [],
    gatheredAt: new Date().toISOString(),
  };
}

describe('WriterAgent', () => {
  it('recovers content from malformed nested JSON string output', async () => {
    const malformed = `{"title":"Validating the End-to-End Blog RAG Pipeline: A Smoke Test Guide","slug":"validating-the-end-to-end-blog-rag-pipeline-a-smoke-test-guide","content":"{"title":"Validating the End-to-End Blog RAG Pipeline: A Smoke Test Guide","slug":"validating-blog-rag-pipeline","content":"The RAG pipeline is the magic sauce, right? But "it seems fine" is never good enough.\\n\\nCheck ingestion, retrieval, and links.","excerpt":"A smoke test guide for validating RAG end to end.","tags":["how-to"]}","excerpt":"{\"title\":\"broken excerpt wrapper\"}","tags":["how-to"]}`;

    const llm: LLMProvider = {
      name: 'test-llm',
      complete: async () => ({
        text: malformed,
        tokensUsed: { input: 1, output: 1 },
      }),
    };

    const writer = new WriterAgent(llm);
    const result = await writer.write(makeContext(), 'RAG smoke test');

    expect(result.draft.title).toBe('Validating the End-to-End Blog RAG Pipeline: A Smoke Test Guide');
    expect(result.draft.content.startsWith('{')).toBe(false);
    expect(result.draft.content.includes('The RAG pipeline is the magic sauce')).toBe(true);
    expect(result.draft.excerpt.startsWith('{')).toBe(false);
  });
});
