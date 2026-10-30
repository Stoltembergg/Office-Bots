/** Categorias fechadas para os achados da revisão. */
export const REVIEW_CATEGORIES = ['security', 'performance', 'tests', 'design'] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

/** Severidade declarada pelo revisor; não representa uma decisão de bloqueio. */
export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export interface ReviewFinding {
  readonly category: ReviewCategory;
  readonly severity: ReviewSeverity;
  readonly title: string;
  readonly explanation: string;
  readonly suggestion: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ReviewReport {
  readonly findings: readonly ReviewFinding[];
}

export const MAX_REVIEW_FINDINGS = 100;
export const MAX_REVIEW_TITLE_LENGTH = 200;
export const MAX_REVIEW_EXPLANATION_LENGTH = 4_000;
export const MAX_REVIEW_SUGGESTION_LENGTH = 4_000;
export const MAX_REVIEW_PATH_LENGTH = 512;
export const MAX_REVIEW_TOTAL_TEXT_LENGTH = 250_000;
export const MAX_REVIEW_LINE = 10_000_000;

const REPORT_KEYS = ['findings'] as const;
const FINDING_KEYS = [
  'category', 'severity', 'title', 'explanation', 'suggestion', 'path', 'startLine', 'endLine',
] as const;
const CONTROL_OR_BIDI = /[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const PATH_CONTROL_OR_BIDI = CONTROL_OR_BIDI;

/**
 * Valida e copia a forma de um relatório não confiável.
 * Os textos são dados opacos: esta função não os interpreta, não confirma achados contra um diff e não resolve
 * caminhos no filesystem. Consumidores devem continuar tratando o conteúdo como não confiável.
 */
export function parseReviewReport(raw: unknown): ReviewReport | null {
  try {
    const report = exactDataObject(raw, REPORT_KEYS);
    if (!report) return null;
    const rawFindings = exactDataArray(report.findings, MAX_REVIEW_FINDINGS);
    if (!rawFindings) return null;

    const findings: ReviewFinding[] = [];
    let totalTextLength = 0;
    for (const rawFinding of rawFindings) {
      const finding = exactDataObject(rawFinding, FINDING_KEYS);
      if (!finding || !isCategory(finding.category) || !isSeverity(finding.severity)
        || !isText(finding.title, MAX_REVIEW_TITLE_LENGTH)
        || !isText(finding.explanation, MAX_REVIEW_EXPLANATION_LENGTH)
        || !isText(finding.suggestion, MAX_REVIEW_SUGGESTION_LENGTH)
        || !isSafeRelativePath(finding.path)
        || !isLine(finding.startLine) || !isLine(finding.endLine) || finding.endLine < finding.startLine) return null;

      totalTextLength += finding.title.length + finding.explanation.length + finding.suggestion.length + finding.path.length;
      if (totalTextLength > MAX_REVIEW_TOTAL_TEXT_LENGTH) return null;

      findings.push({
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        explanation: finding.explanation,
        suggestion: finding.suggestion,
        path: finding.path,
        startLine: finding.startLine,
        endLine: finding.endLine,
      });
    }

    return { findings };
  } catch {
    // Proxy traps and other non-JSON objects must fail closed instead of escaping validation.
    return null;
  }
}

/** Type guard correspondente a parseReviewReport, sem expor conteúdo adicional. */
export function isReviewReport(raw: unknown): raw is ReviewReport {
  return parseReviewReport(raw) !== null;
}

function exactDataObject<const K extends readonly string[]>(raw: unknown, keys: K): Record<K[number], unknown> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return null;

  const ownKeys = Reflect.ownKeys(raw);
  const allowedKeys: readonly string[] = keys;
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !allowedKeys.includes(key))) return null;

  const values = Object.create(null) as Record<K[number], unknown>;
  for (const key of keys as readonly K[number][]) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
    values[key] = descriptor.value;
  }
  return values;
}

function exactDataArray(raw: unknown, maxLength: number): unknown[] | null {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value > maxLength) return null;

  const length = lengthDescriptor.value as number;
  const ownKeys = Reflect.ownKeys(raw);
  if (ownKeys.length !== length + 1) return null;

  const values: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
    values.push(descriptor.value);
  }
  return values;
}

function isCategory(value: unknown): value is ReviewCategory {
  return typeof value === 'string' && (REVIEW_CATEGORIES as readonly string[]).includes(value);
}

function isSeverity(value: unknown): value is ReviewSeverity {
  return typeof value === 'string' && (REVIEW_SEVERITIES as readonly string[]).includes(value);
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    && !CONTROL_OR_BIDI.test(value.replace(/[\t\n\r]/g, ''));
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REVIEW_PATH_LENGTH
    || value !== value.trim() || value.startsWith('/') || value.includes('\\') || value.includes(':')
    || PATH_CONTROL_OR_BIDI.test(value)) return false;

  const segments = value.split('/');
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_REVIEW_LINE;
}
