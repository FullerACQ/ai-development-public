import { describe, expect, test } from "bun:test";
import { extractUrls } from "./urls";

describe("extractUrls", () => {
  const cases: readonly Readonly<{ text: string; urls: readonly string[] }>[] = [
    { text: "Visit https://example.com/a, then http://localhost:3000/path!", urls: ["https://example.com/a", "http://localhost:3000/path"] },
    { text: "[PR](https://github.com/ACQ/repo/pull/4/files?diff=split#abc)", urls: ["https://github.com/ACQ/repo/pull/4/files?diff=split#abc"] },
    { text: "[nested](https://example.com/a_(b(c))) and (https://example.com/x).", urls: ["https://example.com/a_(b(c))", "https://example.com/x"] },
    { text: '<https://example.com?q=a%20b> [title](https://example.com/x "A title")', urls: ["https://example.com?q=a%20b", "https://example.com/x"] },
    { text: '`https://example.com/a`; ```txt\nhttp://example.com/b\n```', urls: ["https://example.com/a", "http://example.com/b"] },
    { text: "**https://example.com/bold**. _https://example.com/a_b_ and ~~https://example.com/c~~", urls: ["https://example.com/bold", "https://example.com/a_b", "https://example.com/c"] },
    { text: "https://example.com/a_b_ https://example.com/it's-a-path", urls: ["https://example.com/a_b_", "https://example.com/it's-a-path"] },
    { text: '"https://example.com/quoted" and \'https://example.com/single\' “https://example.com/curly”', urls: ["https://example.com/quoted", "https://example.com/single", "https://example.com/curly"] },
    { text: "https://example.com/p?!;:., https://example.com/a%29#frag", urls: ["https://example.com/p", "https://example.com/a%29#frag"] },
    { text: "https://example.com/x)words https://example.com/y]more https://example.com/{z}", urls: ["https://example.com/x", "https://example.com/y", "https://example.com/{z}"] },
    { text: "https://one.example,https://two.example;http://three.example", urls: ["https://one.example", "https://two.example", "http://three.example"] },
    { text: "https://example.com/?next=https://other.example/a&x=1", urls: ["https://example.com/?next=https://other.example/a&x=1"] },
    { text: "HTTP://[::1]:8080/A%2fb?Q=Mixed+Case&x=é#frag", urls: ["HTTP://[::1]:8080/A%2fb?Q=Mixed+Case&x=é#frag"] },
    { text: "ftp://example.com mailto:me@example.com https:// http://) https://valid.example", urls: ["https://valid.example"] },
    { text: "https://example.com/a\\(b\\)", urls: ["https://example.com/a\\(b\\)"] },
  ];
  for (const { text, urls } of cases) {
    test(text, () => {
      const found = extractUrls(text);
      expect(found.map((item) => item.url)).toEqual([...urls]);
      for (const item of found) {
        expect(text.slice(item.start, item.end)).toBe(item.url);
        expect(item.end - item.start).toBe(item.url.length);
      }
    });
  }

  test("Unicode preceding text and repeated occurrences have original UTF-16 offsets", () => {
    const url = "https://EXAMPLE.com/%2f?x=é";
    const text = `🦑 ${url}\n${url}.`;
    expect(extractUrls(text)).toEqual([
      { url, start: 3, end: 3 + url.length },
      { url, start: 4 + url.length, end: 4 + 2 * url.length },
    ]);
  });

  test("input is never rewritten", () => {
    const text = "[copy](https://EXAMPLE.COM:443/a%2fb?x=A+B&y=%7e#C).";
    expect(extractUrls(text)[0]?.url).toBe("https://EXAMPLE.COM:443/a%2fb?x=A+B&y=%7e#C");
    expect(text).toBe("[copy](https://EXAMPLE.COM:443/a%2fb?x=A+B&y=%7e#C).");
  });
});
