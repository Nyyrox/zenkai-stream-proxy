import { fetchHtml, decodeEntities } from "../core/new-provider-utils.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function canExtractAnimeSalt(url = "") {
  const low = url.toLowerCase();
  return (
    low.includes("animesalt.cx") ||
    low.includes("animesalt.ac") ||
    low.includes("animesalt.ro") ||
    low.includes("as-cdn") ||
    low.includes("acdn.top") ||
    low.includes("animesalt")
  );
}

/**
 * Dean Edwards P.A.C.K.E.R. Unpacker
 */
function unpackJs(packed = "") {
  try {
    const match = packed.match(
      /eval\(function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[rd]\s*\)[\s\S]*?\}\s*\(\s*'(.*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*?)'\.split\('\|'\)/
    );
    if (!match) return packed;

    let [, p, a, c, k] = match;
    const base = Number(a);
    const count = Number(c);
    const words = k.split("|");

    function decodeBaseN(val, radix) {
      const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
      if (val < radix) return chars[val];
      return decodeBaseN(Math.floor(val / radix), radix) + chars[val % radix];
    }

    const dict = {};
    for (let i = 0; i < count; i++) {
      dict[decodeBaseN(i, base)] = words[i] || decodeBaseN(i, base);
    }

    return p.replace(/\b\w+\b/g, (w) => dict[w] ?? w);
  } catch {
    return packed;
  }
}

/**
 * Searches HTML and JS snippets for direct .m3u8 streams
 */
function findM3u8InText(text = "") {
  if (!text) return null;
  const unpacked = unpackJs(text);
  const patterns = [
    /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /src\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\/hls\/[^"']+\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
  ];

  for (const pattern of patterns) {
    const m = unpacked.match(pattern);
    if (m && m[1]) {
      return decodeEntities(m[1].replace(/\\\//g, "/"));
    }
  }
  return null;
}

/**
 * Extracts HLS stream from an AnimeSalt episode or player embed URL
 */
export async function extractAnimeSalt(url, referer = "https://animesalt.cx/") {
  const details = await extractAnimeSaltDetails(url, referer);
  return details?.streamUrl ?? null;
}

export async function extractAnimeSaltDetails(url, referer = "https://animesalt.cx/") {
  try {
    const rawHtml = await fetchHtml(url, {
      Referer: referer,
      "User-Agent": DEFAULT_UA,
    });

    // 1. Direct search in page HTML
    let directHls = findM3u8InText(rawHtml);
    if (directHls) {
      return {
        streamUrl: directHls,
        isHls: true,
        headers: { Referer: referer, "User-Agent": DEFAULT_UA },
        subtitles: [],
      };
    }

    // 2. Base64 encoded buttons: loadMi({ value: '...' })
    const loadMiRegex = /loadMi\(\{\s*value:\s*'([^']+)'/gi;
    let match;
    while ((match = loadMiRegex.exec(rawHtml)) !== null) {
      try {
        const b64 = match[1];
        const decoded = atob(b64);
        const iframeSrc = decoded.match(/<iframe[^>]*(?:data-src|src)=["']([^"']+)["']/i)?.[1];
        if (iframeSrc) {
          let targetSrc = iframeSrc.trim();
          if (targetSrc.startsWith("//")) targetSrc = `https:${targetSrc}`;
          const iframeHtml = await fetchHtml(targetSrc, { Referer: url, "User-Agent": DEFAULT_UA }).catch(() => "");
          const hls = findM3u8InText(iframeHtml);
          if (hls) {
            return {
              streamUrl: hls,
              isHls: true,
              headers: { Referer: `${new URL(targetSrc).origin}/`, "User-Agent": DEFAULT_UA },
              subtitles: [],
            };
          }
        }
      } catch {}
    }

    // 3. Regular iframes inside container
    const iframeMatches = [...rawHtml.matchAll(/<iframe[^>]*(?:data-src|src)=["']([^"']+)["']/gi)];
    for (const ifm of iframeMatches) {
      let src = ifm[1].trim();
      if (src.startsWith("//")) src = `https:${src}`;
      if (src.startsWith("/")) src = `https://animesalt.cx${src}`;
      if (!src.includes("about:blank") && !src.includes("google")) {
        const iframeHtml = await fetchHtml(src, { Referer: url, "User-Agent": DEFAULT_UA }).catch(() => "");
        const hls = findM3u8InText(iframeHtml);
        if (hls) {
          return {
            streamUrl: hls,
            isHls: true,
            headers: { Referer: `${new URL(src).origin}/`, "User-Agent": DEFAULT_UA },
            subtitles: [],
          };
        }
      }
    }

    // 4. as-cdn / acdn video hash
    const cdnHashMatch = rawHtml.match(/as-cdn\d*\.top\/video\/([a-zA-Z0-9]+)/i);
    if (cdnHashMatch) {
      const hash = cdnHashMatch[1];
      const directCandidate = `https://as-cdn1.top/hls/${hash}/master.m3u8`;
      return {
        streamUrl: directCandidate,
        isHls: true,
        headers: { Referer: "https://animesalt.cx/", "User-Agent": DEFAULT_UA },
        subtitles: [],
      };
    }

    return null;
  } catch (err) {
    console.error("[extractAnimeSalt] Failed:", err.message);
    return null;
  }
}
