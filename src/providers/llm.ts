/**
 * LLM Provider Interface
 * Abstraction over Claude API and Ollama so agents can swap backends.
 */

export interface LLMCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature?: number;
}

export interface LLMResponse {
  text: string;
  tokensUsed: { input: number; output: number };
  finishReason?: string;
}

export interface LLMProvider {
  readonly name: string;
  complete(request: LLMCompletionRequest): Promise<LLMResponse>;
}
