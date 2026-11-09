/** Offsets are UTF-16 indices: text.slice(start, end) is exactly url. */
export type UrlMatch = Readonly<{ url: string; start: number; end: number }>;

const OPENERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set(Object.values(OPENERS));
const DELIMITER = /[\s\u0000-\u001f\u007f-\u009f<>"`“”‘’]/u;
const TRAILING_PUNCTUATION = /[.,;:!?']/u;

/**
 * Extract HTTP(S) links from prose, markdown, and code without reserializing them.
 * Balanced parentheses/brackets belong to the URL; unmatched closers and prose
 * punctuation do not. Markdown emphasis immediately surrounding a URL is removed.
 * Literal trailing prose punctuation is ambiguous; percent-encode it when it is
 * intended to be part of the URL. Repeated occurrences retain separate offsets.
 */
export function extractUrls(text: string): readonly UrlMatch[] {
  const links: UrlMatch[] = [];
  const schemes = /https?:\/\//giu;
  for (const match of text.matchAll(schemes)) {
    const start = match.index;
    const previous = links.at(-1);
    if (previous !== undefined && start < previous.end) continue;

    const stack: string[] = [];
    const quoted = text[start - 1] === "'";
    let end = start + match[0].length;
    while (end < text.length) {
      const char = text[end]!;
      if (DELIMITER.test(char) || (quoted && char === "'")) break;
      if ((char === "," || char === ";") && /^https?:\/\//iu.test(text.slice(end + 1))) break;
      const closer = OPENERS[char];
      if (closer !== undefined) stack.push(closer);
      else if (CLOSERS.has(char)) {
        if (stack.at(-1) !== char) break;
        stack.pop();
      }
      end++;
    }

    while (end > start && TRAILING_PUNCTUATION.test(text[end - 1]!)) end--;
    // Strip only matching surrounding markdown markers, not legal URL underscores.
    const emphasis = text.slice(0, start).match(/(\*{1,3}|_{1,3}|~~)$/u);
    if (emphasis !== null && text.slice(start, end).endsWith(emphasis[0])) {
      end -= emphasis[0].length;
    }
    while (end > start && TRAILING_PUNCTUATION.test(text[end - 1]!)) end--;

    const url = text.slice(start, end);
    try {
      const parsed = new URL(url);
      if (parsed.hostname.length === 0) continue;
    } catch {
      // FALLBACK: arbitrary chat can contain incomplete HTTP literals; not links.
      continue;
    }
    links.push({ url, start, end });
  }
  return links;
}
