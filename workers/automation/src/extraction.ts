export const MAX_JOB_PAGE_BYTES = 1_048_576;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8_000;

export interface JobPageFields {
  company?: string;
  role?: string;
}

export interface JobPageResult {
  url: string;
  finalUrl: string;
  status: number | null;
  contentType: string | null;
  fetchedAt: string;
  company: string;
  role: string;
  title: string;
  atsId?: string;
  description: string;
  body: string;
  source: 'jobposting' | 'opengraph' | 'html' | 'unavailable';
}

export type JobPageFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function extractJobPage(
  value: string,
  supplied: JobPageFields = {},
  fetcher: JobPageFetcher = fetch,
): Promise<JobPageResult> {
  const initialUrl = assertPublicHttpsUrl(value);
  let url = initialUrl;
  let response: Response | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('Job page fetch timed out'), FETCH_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      response = await fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9' },
      });
      if (response.status >= 300 && response.status < 400) {
        if (redirects === MAX_REDIRECTS) throw new Error('Job page redirected too many times');
        const location = response.headers.get('location');
        if (!location) throw new Error('Job page redirect has no location');
        url = assertPublicHttpsUrl(new URL(location, url).toString());
        continue;
      }
      break;
    }
    if (!response) throw new Error('Job page fetch failed');
    if (!response.ok) throw new Error(`Job page returned ${response.status}`);
    const contentType = response.headers.get('content-type');
    if (contentType && !/^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType)) {
      throw new Error('Job page is not HTML');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JOB_PAGE_BYTES) throw new Error('Job page is too large');
    const html = await readBoundedText(response, MAX_JOB_PAGE_BYTES);
    const extracted = extractHtmlFields(html);
    const company = supplied.company?.trim() || extracted.company;
    const role = supplied.role?.trim() || extracted.role;
    return {
      url: initialUrl,
      finalUrl: url,
      status: response.status,
      contentType,
      fetchedAt: new Date().toISOString(),
      company,
      role,
      title: extracted.title,
      ...(extracted.atsId ? { atsId: extracted.atsId } : {}),
      description: extracted.description,
      body: extracted.body,
      source: extracted.source,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function assertPublicHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Job URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new TypeError('Job URL must use public HTTPS');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname === 'metadata.google.internal') {
    throw new TypeError('Private job URL is not allowed');
  }
  if (isIpLiteral(hostname) && !isPublicIpLiteral(hostname)) throw new TypeError('Private job URL is not allowed');
  url.hash = '';
  return url.toString();
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel('Job page exceeds the size limit');
        throw new Error('Job page is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function extractHtmlFields(html: string): Omit<JobPageResult, 'url' | 'finalUrl' | 'status' | 'contentType' | 'fetchedAt' | 'company' | 'role'> & { company: string; role: string } {
  const jsonLd = [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)];
  for (const script of jsonLd) {
    try {
      const job = findJobPosting(JSON.parse(decodeEntities(script[1] ?? '')));
      if (job) {
        const company = plainText(job.hiringOrganization && typeof job.hiringOrganization === 'object'
          ? (job.hiringOrganization as Record<string, unknown>).name : '');
        const role = plainText(job.title);
        const description = plainText(job.description).slice(0, 20_000);
        const atsId = postingIdentifier(job.identifier);
        return { company, role, title: role || htmlTitle(html), ...(atsId ? { atsId } : {}),
          description, body: description || visibleText(html), source: 'jobposting' };
      }
    } catch {
      // Ignore malformed structured data and use page metadata.
    }
  }
  const ogCompany = metaContent(html, ['og:site_name', 'og:brand']);
  const ogTitle = metaContent(html, ['og:title', 'twitter:title']) || htmlTitle(html);
  const description = metaContent(html, ['og:description', 'description', 'twitter:description']).slice(0, 20_000);
  return {
    company: ogCompany,
    role: ogTitle,
    title: ogTitle,
    description,
    body: visibleText(html),
    source: ogCompany || ogTitle || description ? 'opengraph' : 'html',
  };
}

function postingIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string') return boundedIdentifier(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property = value as Record<string, unknown>;
  const type = Array.isArray(property['@type']) ? property['@type'] : [property['@type']];
  if (!type.some(entry => typeof entry === 'string' && /(?:^|[/#])PropertyValue$/i.test(entry))) return undefined;
  if (typeof property.propertyID !== 'string' || !property.propertyID.trim() || property.propertyID.length > 128) return undefined;
  return typeof property.value === 'string' ? boundedIdentifier(property.value) : undefined;
}

function boundedIdentifier(value: string): string | undefined {
  const result = value.trim();
  return result && result.length <= 256 ? result : undefined;
}

function findJobPosting(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const job = findJobPosting(item);
      if (job) return job;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  const types = Array.isArray(object['@type']) ? object['@type'] : [object['@type']];
  if (types.some((type) => typeof type === 'string' && /(?:^|[\/#])jobposting$/i.test(type))) return object;
  if (Array.isArray(object['@graph'])) return findJobPosting(object['@graph']);
  return undefined;
}

function metaContent(html: string, names: string[]): string {
  for (const meta of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = meta[0];
    const key = attribute(tag, 'property') || attribute(tag, 'name') || attribute(tag, 'itemprop');
    if (key && names.includes(key.toLowerCase())) return plainText(attribute(tag, 'content'));
  }
  return '';
}

function attribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function htmlTitle(html: string): string {
  return plainText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '');
}

function visibleText(html: string): string {
  return plainText(html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')).slice(0, 40_000);
}

function plainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return decodeEntities(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return decodeCodePoint(match, Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return decodeCodePoint(match, Number.parseInt(lower.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[lower] ?? match;
  });
}

function decodeCodePoint(fallback: string, value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : fallback;
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

function isPublicIpLiteral(hostname: string): boolean {
  if (hostname.includes(':')) {
    const normalized = hostname.toLowerCase();
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIpv4(mapped[1]);
    const segments = normalized.split(':');
    const firstSegment = Number.parseInt(segments[0] || '0', 16);
    const secondSegment = Number.parseInt(segments[1] || '0', 16);
    if (firstSegment === 0x2001 && secondSegment === 0x0db8) return false;
    return firstSegment >= 0x2000 && firstSegment <= 0x3fff;
  }
  return isPublicIpv4(hostname);
}

function isPublicIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}
