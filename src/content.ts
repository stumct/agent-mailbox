const HTTP_URL = /https?:\/\/[^\s<>"')\]]+/giu;
const HREF = /href\s*=\s*["']([^"']+)["']/giu;
const VERIFICATION_CODE = /(?<!\d)\d{4,8}(?!\d)/gu;

export function extractLinks(text?: string, html?: string): string[] {
  const links = new Set<string>();

  for (const source of [text, html]) {
    if (!source) continue;
    for (const match of source.matchAll(HTTP_URL)) addHttpUrl(links, match[0]);
  }

  if (html) {
    for (const match of html.matchAll(HREF)) {
      const href = match[1];
      if (href) addHttpUrl(links, decodeHtml(href));
    }
  }

  return [...links];
}

export function extractCodes(text?: string, html?: string): string[] {
  const codes = new Set<string>();
  const content = `${text ?? ""}\n${stripHtml(html ?? "")}`;
  for (const match of content.matchAll(VERIFICATION_CODE)) codes.add(match[0]);
  return [...codes];
}

function addHttpUrl(links: Set<string>, raw: string): void {
  const candidate = decodeHtml(raw).replace(/[.,;:!?]+$/, "");
  try {
    const url = new URL(candidate);
    if (url.protocol === "http:" || url.protocol === "https:") links.add(url.toString());
  } catch {
    // Malformed URLs in untrusted email content are ignored.
  }
}

function stripHtml(html: string): string {
  return decodeHtml(html.replace(/<[^>]*>/gu, " "));
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
