/**
 * Skill Validator — validates skill content, memory updates, and IPC messages.
 *
 * All validation runs on the host before any write occurs.
 * Credential patterns are detected and blocked/stripped.
 */
import { logger } from './logger.js';

// --- Credential detection patterns ---

const CREDENTIAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // API keys
  { name: 'OpenAI/Anthropic key', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Publishable key', pattern: /pk_(?:live|test)_[A-Za-z0-9]{10,}/ },
  { name: 'Generic API key', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*\S+/i },
  // AWS
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  {
    name: 'AWS secret key',
    pattern: /(?:aws_secret_access_key|aws_access_key_id)\s*[:=]\s*\S+/i,
  },
  // Tokens
  { name: 'Bearer token', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  {
    name: 'Access/refresh token',
    pattern: /(?:access_token|refresh_token)\s*[:=]\s*\S+/i,
  },
  { name: 'Token assignment', pattern: /\btoken\s*[:=]\s*['"][^'"]{10,}['"]/i },
  // Passwords
  {
    name: 'Password assignment',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
  },
  { name: 'Secret assignment', pattern: /\bsecret\s*[:=]\s*\S+/i },
  // URLs with embedded credentials
  {
    name: 'URL with credentials',
    pattern: /:\/\/[^:\s]+:[^@\s]+@[^\s]+/,
  },
  // Generic long base64 secrets (likely keys)
  {
    name: 'Base64 secret',
    pattern: /(?:key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9+/=]{40,}['"]?/i,
  },
];

// --- Shell escape detection patterns ---

const SHELL_ESCAPE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'Backtick substitution', pattern: /`[^`]*(?:curl|wget|nc|bash|sh|eval|exec)[^`]*`/ },
  { name: 'Dollar substitution', pattern: /\$\([^)]*(?:curl|wget|nc|bash|sh|eval|exec)[^)]*\)/ },
  {
    name: 'Pipe to network tool',
    pattern: /\|\s*(?:curl|wget|nc|netcat)\s/,
  },
  {
    name: 'Credential file reference',
    pattern: /~\/\.(?:ssh|aws|gnupg|env)\b/,
  },
  {
    name: 'Direct env file read',
    pattern: /cat\s+.*\.env\b/,
  },
];

// --- Size limits ---

const SKILL_MAX_SIZE = 10 * 1024; // 10 KB
const MEMORY_MAX_SIZE = 50 * 1024; // 50 KB
const IPC_MAX_SIZE = 100 * 1024; // 100 KB

// --- Known IPC types and required fields ---

const IPC_SCHEMAS: Record<string, { required: string[]; optional?: string[] }> =
  {
    message: { required: ['chatJid', 'text'] },
    schedule_task: {
      required: ['prompt', 'schedule_type', 'schedule_value', 'targetJid'],
      optional: ['taskId', 'context_mode', 'script'],
    },
    pause_task: { required: ['taskId'] },
    resume_task: { required: ['taskId'] },
    cancel_task: { required: ['taskId'] },
    update_task: {
      required: ['taskId'],
      optional: ['prompt', 'script', 'schedule_type', 'schedule_value'],
    },
    refresh_groups: { required: [] },
    register_group: {
      required: ['jid', 'name', 'folder', 'trigger'],
      optional: ['requiresTrigger', 'containerConfig'],
    },
    propose_skill: { required: ['name', 'content'] },
    update_memory: { required: ['content'] },
    search_sessions: { required: ['query'] },
  };

// --- Helpers ---

function findCredentials(content: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) {
      found.push(name);
    }
  }
  return found;
}

function findShellEscapes(content: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of SHELL_ESCAPE_PATTERNS) {
    if (pattern.test(content)) {
      found.push(name);
    }
  }
  return found;
}

function stripCredentials(content: string): string {
  let result = content;
  for (const { pattern } of CREDENTIAL_PATTERNS) {
    result = result.replace(new RegExp(pattern, 'g'), '[REDACTED]');
  }
  return result;
}

// --- Public API ---

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface MemoryValidationResult {
  valid: boolean;
  sanitized: string;
}

/**
 * Validate skill content before writing to disk.
 * Checks size, credential patterns, and shell escapes.
 */
export function validateSkillContent(content: string): ValidationResult {
  const errors: string[] = [];

  // Size check
  const byteSize = Buffer.byteLength(content, 'utf-8');
  if (byteSize > SKILL_MAX_SIZE) {
    errors.push(
      `Skill exceeds ${SKILL_MAX_SIZE / 1024}KB limit (${byteSize} bytes)`,
    );
  }

  // Empty check
  if (!content.trim()) {
    errors.push('Skill content is empty');
  }

  // Credential check
  const credentials = findCredentials(content);
  if (credentials.length > 0) {
    errors.push(`Credential patterns detected: ${credentials.join(', ')}`);
  }

  // Shell escape check
  const shellEscapes = findShellEscapes(content);
  if (shellEscapes.length > 0) {
    errors.push(`Shell escape patterns detected: ${shellEscapes.join(', ')}`);
  }

  if (errors.length > 0) {
    logger.warn(
      { errors, contentLength: byteSize },
      'Skill validation failed',
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate and sanitize memory content.
 * Strips credentials instead of rejecting outright.
 * Truncates if over size limit.
 */
export function validateMemoryContent(content: string): MemoryValidationResult {
  let sanitized = content;
  let valid = true;

  // Strip credentials (warn but don't reject)
  const credentials = findCredentials(sanitized);
  if (credentials.length > 0) {
    logger.warn(
      { patterns: credentials },
      'Credentials detected in memory update — stripping',
    );
    sanitized = stripCredentials(sanitized);
    // Still valid, just sanitized
  }

  // Size check — truncate with warning
  const byteSize = Buffer.byteLength(sanitized, 'utf-8');
  if (byteSize > MEMORY_MAX_SIZE) {
    logger.warn(
      { byteSize, limit: MEMORY_MAX_SIZE },
      'Memory content exceeds limit — truncating',
    );
    // Truncate to limit (rough cut at byte boundary, then trim to last newline)
    const truncated = Buffer.from(sanitized, 'utf-8')
      .subarray(0, MEMORY_MAX_SIZE)
      .toString('utf-8');
    const lastNewline = truncated.lastIndexOf('\n');
    sanitized =
      lastNewline > 0
        ? truncated.slice(0, lastNewline) +
          '\n\n<!-- Truncated: exceeded 50KB limit -->\n'
        : truncated;
  }

  // Empty is technically valid but flag it
  if (!sanitized.trim()) {
    valid = false;
    logger.warn('Empty memory content after sanitization');
  }

  return { valid, sanitized };
}

/**
 * Validate an IPC message type and payload.
 * Checks type is known, required fields present, and no credentials in string values.
 */
export function validateIPCMessage(
  type: string,
  payload: unknown,
): ValidationResult {
  const errors: string[] = [];

  // Type must be known
  const schema = IPC_SCHEMAS[type];
  if (!schema) {
    errors.push(`Unknown IPC message type: "${type}"`);
    logger.warn({ type }, 'Unknown IPC message type');
    return { valid: false, errors };
  }

  // Payload must be an object
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    errors.push('IPC payload must be a non-null object');
    logger.warn({ type }, 'Invalid IPC payload shape');
    return { valid: false, errors };
  }

  const data = payload as Record<string, unknown>;

  // Required fields
  for (const field of schema.required) {
    if (data[field] === undefined || data[field] === null) {
      errors.push(`Missing required field: "${field}" for type "${type}"`);
    }
  }

  // Size check on serialized payload
  const serialized = JSON.stringify(payload);
  if (serialized.length > IPC_MAX_SIZE) {
    errors.push(
      `IPC payload exceeds ${IPC_MAX_SIZE / 1024}KB limit (${serialized.length} bytes)`,
    );
  }

  // Credential scan on all string values
  const stringValues = extractStrings(data);
  const allContent = stringValues.join(' ');
  const credentials = findCredentials(allContent);
  if (credentials.length > 0) {
    errors.push(
      `Credentials detected in IPC payload: ${credentials.join(', ')}`,
    );
  }

  if (errors.length > 0) {
    logger.warn({ type, errors }, 'IPC message validation failed');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Recursively extract all string values from an object.
 */
function extractStrings(obj: Record<string, unknown>): string[] {
  const strings: string[] = [];
  for (const value of Object.values(obj)) {
    if (typeof value === 'string') {
      strings.push(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      strings.push(...extractStrings(value as Record<string, unknown>));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          strings.push(item);
        } else if (typeof item === 'object' && item !== null) {
          strings.push(...extractStrings(item as Record<string, unknown>));
        }
      }
    }
  }
  return strings;
}
