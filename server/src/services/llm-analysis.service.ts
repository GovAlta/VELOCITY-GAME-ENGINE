import { env } from '../config/environment';
import { AppError } from '../utils/app-error';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditAnalysisResult {
  overallScore: number;
  completionEstimate: number;
  findings: Array<{
    category: string;
    severity: 'info' | 'warning' | 'critical';
    description: string;
    evidence: string;
  }>;
  recommendations: string[];
  summary: string;
}

export type LlmProvider = 'claude' | 'gemini' | 'grok';

// ---------------------------------------------------------------------------
// Retry utility
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, context: string, maxRetries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const status = error?.status || error?.statusCode || 0;
      // Don't retry 4xx errors except 429 (rate limit)
      if (status >= 400 && status < 500 && status !== 429) throw error;
      if (attempt === maxRetries) break;
      const delayMs = status === 429
        ? 15000 * Math.pow(2, attempt)
        : 2000 * Math.pow(3, attempt) + Math.random() * 3000;
      logger.warn(`[${context}] Retry ${attempt + 1}/${maxRetries} after ${Math.round(delayMs)}ms`, { error: (error as Error).message?.substring(0, 200) });
      await delay(delayMs);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// JSON parsing with fallbacks
// ---------------------------------------------------------------------------

function parseJsonResponse(text: string): AuditAnalysisResult {
  try {
    return JSON.parse(text);
  } catch {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) return JSON.parse(fenceMatch[1].trim());
    const rawMatch = text.match(/[\[{][\s\S]*[\]}]/);
    if (rawMatch) return JSON.parse(rawMatch[0]);
    throw new Error(`Failed to parse JSON from LLM response: ${text.substring(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Tool definition for structured output
// ---------------------------------------------------------------------------

const AUDIT_ANALYSIS_SCHEMA = {
  type: 'object' as const,
  properties: {
    overallScore: { type: 'number' as const, description: 'Overall project health score 0-100' },
    completionEstimate: { type: 'number' as const, description: 'Estimated completion percentage 0-100' },
    findings: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          category: { type: 'string' as const, description: 'Category: code-quality, velocity, team, process, risk, security' },
          severity: { type: 'string' as const, enum: ['info', 'warning', 'critical'] },
          description: { type: 'string' as const },
          evidence: { type: 'string' as const },
        },
        required: ['category', 'severity', 'description', 'evidence'],
      },
    },
    recommendations: { type: 'array' as const, items: { type: 'string' as const } },
    summary: { type: 'string' as const, description: '3-5 sentence summary' },
  },
  required: ['overallScore', 'completionEstimate', 'findings', 'recommendations', 'summary'],
};

// ---------------------------------------------------------------------------
// Default prompt
// ---------------------------------------------------------------------------

const DEFAULT_AUDIT_PROMPT = `You are an expert project analyst reviewing a software project's analytics data.
Analyze the project health, team velocity, code quality, and risk factors.
Provide scores, findings with evidence, and actionable recommendations.
Be specific and reference data from the provided analytics.`;

// ---------------------------------------------------------------------------
// Claude (Anthropic) provider — using tool_use for structured JSON
// ---------------------------------------------------------------------------

export async function analyzeWithClaude(
  prompt: string,
  data: unknown,
  model?: string
): Promise<AuditAnalysisResult> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw AppError.badRequest('ANTHROPIC_API_KEY is not configured');

  const selectedModel = model || 'claude-sonnet-4-6';
  const userMessage = `${prompt}\n\n## Project Data\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 80000)}\n\`\`\``;

  return withRetry(async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 64000,
        tools: [{
          name: 'audit_analysis',
          description: 'Submit structured analysis of a project audit',
          input_schema: AUDIT_ANALYSIS_SCHEMA,
        }],
        tool_choice: { type: 'tool', name: 'audit_analysis' },
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error('Claude API error', { status: res.status, body: errText.slice(0, 500) });
      const err: any = new Error(`Claude API error (${res.status})`);
      err.status = res.status;
      throw err;
    }

    const responseData = (await res.json()) as {
      content?: Array<{ type: string; name?: string; input?: AuditAnalysisResult; text?: string }>;
    };

    const toolBlock = responseData.content?.find(b => b.type === 'tool_use' && b.name === 'audit_analysis');
    if (toolBlock?.input) return toolBlock.input;

    const textBlock = responseData.content?.find(b => b.type === 'text');
    if (textBlock?.text) return parseJsonResponse(textBlock.text);

    throw AppError.internal('Unexpected Claude response format');
  }, 'claude-analysis');
}

// ---------------------------------------------------------------------------
// Gemini provider — using responseMimeType for JSON mode
// ---------------------------------------------------------------------------

export async function analyzeWithGemini(
  prompt: string,
  data: unknown,
  model?: string
): Promise<AuditAnalysisResult> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw AppError.badRequest('GEMINI_API_KEY is not configured');

  const selectedModel = model || 'gemini-3.0-flash';
  const userMessage = `${prompt}\n\n## Project Data\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 80000)}\n\`\`\`\n\nRespond with ONLY valid JSON matching the audit analysis schema.`;

  return withRetry(async () => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: userMessage }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3,
            maxOutputTokens: 64000,
          },
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      logger.error('Gemini API error', { status: res.status, body: errText.slice(0, 500) });
      const err: any = new Error(`Gemini API error (${res.status})`);
      err.status = res.status;
      throw err;
    }

    const responseData = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw AppError.internal('Empty Gemini response');

    return parseJsonResponse(text);
  }, 'gemini-analysis');
}

// ---------------------------------------------------------------------------
// Grok (xAI) provider — OpenAI-compatible API with json_object mode
// ---------------------------------------------------------------------------

export async function analyzeWithGrok(
  prompt: string,
  data: unknown,
  model?: string
): Promise<AuditAnalysisResult> {
  const apiKey = env.XAI_API_KEY;
  if (!apiKey) throw AppError.badRequest('XAI_API_KEY is not configured');

  const selectedModel = model || 'grok-3-mini-fast';
  const userMessage = `${prompt}\n\n## Project Data\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 80000)}\n\`\`\`\n\nRespond with ONLY valid JSON matching the audit analysis schema.`;

  return withRetry(async () => {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          { role: 'system', content: 'You are a project analytics expert. Always respond with valid JSON only.' },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 64000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error('Grok API error', { status: res.status, body: errText.slice(0, 500) });
      const err: any = new Error(`Grok API error (${res.status})`);
      err.status = res.status;
      throw err;
    }

    const responseData = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const text = responseData.choices?.[0]?.message?.content;
    if (!text) throw AppError.internal('Empty Grok response');

    return parseJsonResponse(text);
  }, 'grok-analysis');
}

// ---------------------------------------------------------------------------
// Dispatcher — with model selection
// ---------------------------------------------------------------------------

export async function analyze(
  provider: LlmProvider,
  prompt: string,
  data: unknown,
  model?: string
): Promise<AuditAnalysisResult> {
  const fullPrompt = prompt || DEFAULT_AUDIT_PROMPT;

  switch (provider) {
    case 'claude':
      return analyzeWithClaude(fullPrompt, data, model);
    case 'gemini':
      return analyzeWithGemini(fullPrompt, data, model);
    case 'grok':
      return analyzeWithGrok(fullPrompt, data, model);
    default:
      throw AppError.badRequest(`Unknown LLM provider: ${provider}`);
  }
}

// ---------------------------------------------------------------------------
// Available providers (for UI selection)
// ---------------------------------------------------------------------------

export function getAvailableProviders(): Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> {
  const available = [];
  if (env.ANTHROPIC_API_KEY) available.push({
    id: 'claude', name: 'Anthropic Claude', models: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    ]
  });
  if (env.GEMINI_API_KEY) available.push({
    id: 'gemini', name: 'Google Gemini', models: [
      { id: 'gemini-3.0-flash', name: 'Gemini 3.0 Flash' },
      { id: 'gemini-2.5-pro-preview-03-25', name: 'Gemini 2.5 Pro' },
    ]
  });
  if (env.XAI_API_KEY) available.push({
    id: 'grok', name: 'xAI Grok', models: [
      { id: 'grok-3-mini-fast', name: 'Grok 3 Mini' },
      { id: 'grok-3', name: 'Grok 3' },
    ]
  });
  return available;
}
