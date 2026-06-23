import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAiProvider,
  registerProvider,
  clearProviderCache,
  getAvailableProviders,
} from '../../../services/ai-providers/provider-factory';
import { OpenAIProvider } from '../../../services/ai-providers/openai.provider';
import type { AiProvider } from '../../../services/ai-providers/ai-provider.interface';

describe('Provider Factory', () => {
  const originalEnv = process.env.AI_PROVIDER;

  beforeEach(() => {
    clearProviderCache();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AI_PROVIDER = originalEnv;
    } else {
      delete process.env.AI_PROVIDER;
    }
    clearProviderCache();
  });

  describe('getAiProvider', () => {
    it('should return OpenAI provider by default', () => {
      delete process.env.AI_PROVIDER;
      const provider = getAiProvider();
      expect(provider).toBeInstanceOf(OpenAIProvider);
      expect(provider.name).toBe('openai');
    });

    it('should return OpenAI provider when AI_PROVIDER=openai', () => {
      process.env.AI_PROVIDER = 'openai';
      const provider = getAiProvider();
      expect(provider).toBeInstanceOf(OpenAIProvider);
    });

    it('should throw for unsupported provider', () => {
      process.env.AI_PROVIDER = 'unknown-provider';
      expect(() => getAiProvider()).toThrow('Unsupported AI provider: "unknown-provider"');
    });

    it('should return cached instance on subsequent calls', () => {
      process.env.AI_PROVIDER = 'openai';
      const provider1 = getAiProvider();
      const provider2 = getAiProvider();
      expect(provider1).toBe(provider2);
    });

    it('should create new instance after cache cleared', () => {
      process.env.AI_PROVIDER = 'openai';
      const provider1 = getAiProvider();
      clearProviderCache();
      const provider2 = getAiProvider();
      expect(provider1).not.toBe(provider2);
    });
  });

  describe('registerProvider', () => {
    it('should register a custom provider', () => {
      const customProvider: AiProvider = {
        name: 'custom',
        isAvailable: () => true,
        chat: async () => 'custom response',
        streamChat: async () => {},
        analyzeImage: async () => 'custom analysis',
      };

      registerProvider('custom', () => customProvider);
      process.env.AI_PROVIDER = 'custom';

      const provider = getAiProvider();
      expect(provider.name).toBe('custom');
    });

    it('should clear cache when registering existing provider name', () => {
      process.env.AI_PROVIDER = 'openai';
      const provider1 = getAiProvider();

      registerProvider('openai', () => ({
        name: 'openai-v2',
        isAvailable: () => true,
        chat: async () => '',
        streamChat: async () => {},
        analyzeImage: async () => '',
      }));

      const provider2 = getAiProvider();
      expect(provider2.name).toBe('openai-v2');
    });
  });

  describe('getAvailableProviders', () => {
    it('should return list of registered providers', () => {
      const providers = getAvailableProviders();
      expect(providers).toContain('openai');
    });

    it('should include custom registered providers', () => {
      registerProvider('anthropic', () => ({
        name: 'anthropic',
        isAvailable: () => true,
        chat: async () => '',
        streamChat: async () => {},
        analyzeImage: async () => '',
      }));

      const providers = getAvailableProviders();
      expect(providers).toContain('openai');
      expect(providers).toContain('anthropic');
    });
  });
});
