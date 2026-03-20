/**
 * Ollama LLM Provider
 * Uses Ollama's OpenAI-compatible /v1/chat/completions endpoint.
 * Target model: petedio-writer (fine-tuned) or any Ollama model.
 */

import { logger } from '../utils/logger.js';
import type { LLMCompletionRequest, LLMProvider, LLMResponse } from './llm.js';

const log = logger.child('ollama-provider');

interface OllamaChatResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OllamaProvider implements LLMProvider {
  readonly name: string;
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model = 'petedio-writer') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.name = `ollama:${model}`;
    log.info(`Initialized Ollama provider — url: ${baseUrl}, model: ${model}`);
  }

  async complete({ systemPrompt, userPrompt, maxTokens, temperature = 0.7 }: LLMCompletionRequest): Promise<LLMResponse> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama API failed (${res.status}): ${body}`);
    }

    const data = await res.json() as OllamaChatResponse;
    const text = data.choices[0]?.message.content ?? '';

    return {
      text,
      tokensUsed: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
      finishReason: data.choices[0]?.finish_reason,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return false;
      const data = await res.json() as { models: Array<{ name: string }> };
      return data.models.some(m => m.name.startsWith(this.model));
    } catch {
      return false;
    }
  }
}
