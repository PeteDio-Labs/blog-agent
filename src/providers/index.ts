import type { LLMProvider } from './llm.js';
import { OllamaProvider } from './ollama.js';

export interface CreateLLMProviderOptions {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

export function createLLMProvider(options: CreateLLMProviderOptions = {}): LLMProvider {
  return new OllamaProvider(
    options.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://192.168.50.59:11434',
    options.ollamaModel ?? process.env.OLLAMA_MODEL ?? 'petedio-writer',
  );
}
