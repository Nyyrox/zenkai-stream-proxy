import crypto from "node:crypto";

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Static MegaPlay AES key & IV from newclient.min.js (UTF-8, right-padded with NULs to 32 bytes)
const MEGAPLAY_STATIC_KEY = Buffer.concat([Buffer.from("i?LMTAx0Q6,:}50U", "utf8"), Buffer.alloc(16)]);
const MEGAPLAY_STATIC_IV = Buffer.from("W0;27ToaUpl_P%'c", "utf8");

function decodeScriptString(value) {
  return value.replace(/\\u([\dA-Fa-f]{4})|\\x([\dA-Fa-f]{2})|\\([\\'"bnfrtv0])/g, (_, unicode, hex, escaped) => {
    if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
    if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
    return { b: "\b", n: "\n", f: "\f", r: "\r", t: "\t", v: "\v", 0: "\0" }[escaped] ?? escaped;
  });
}

function getScriptStrings(script) {
  const strings = [];
  let index = 0;
  let previous = "";
  while (index < script.length) {
    const char = script[index];
    if (char === "/" && script[index + 1] === "/") {
      index = script.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === "/" && script[index + 1] === "*") {
      index = script.indexOf("*/", index + 2);
      if (index < 0) break;
      index += 2;
      continue;
    }
    if (char === "/" && /[=(:,[!&|?{};]/.test(previous)) {
      index++;
      let inClass = false;
      while (index < script.length) {
        if (script[index] === "\\") {
          index += 2;
          continue;
        }
        if (script[index] === "[") inClass = true;
        if (script[index] === "]") inClass = false;
        if (script[index] === "/" && !inClass) {
          index++;
          while (/[a-z]/i.test(script[index] ?? "")) index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      let value = "";
      index++;
      while (index < script.length && script[index] !== quote) {
        if (script[index] === "\\" && index + 1 < script.length) value += script[index++];
        value += script[index++];
      }
      strings.push(decodeScriptString(value));
      index++;
      continue;
    }
    if (char === "`") {
      index++;
      while (index < script.length && script[index] !== "`") index += script[index] === "\\" ? 2 : 1;
      index++;
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    index++;
  }
  return [...new Set(strings)];
}

function getMegaPlayRoutes(script) {
  const routes = getScriptStrings(script)
    .filter((value) => /^stream\/getSources[\w/-]*$/i.test(value))
    .sort((left, right) => left.length - right.length);
  const legacy = routes[0] ?? null;
  const modern = routes.find((route) => route !== legacy && route.startsWith(legacy)) ?? null;
  return { legacy, modern };
}

export function decryptMegaPlayPayload(encValue) {
  if (!encValue || typeof encValue !== "string") return null;
  try {
    const encrypted = Buffer.from(encValue, "base64url");
    if (!encrypted.length || encrypted.length % 16 !== 0) return null;
    const decipher = crypto.createDecipheriv("aes-256-cbc", MEGAPLAY_STATIC_KEY, MEGAPLAY_STATIC_IV);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const data = JSON.parse(decrypted.toString("utf8"));
    const source = data?.file ?? data?.url;
    if (typeof source === "string" && source) return source;
  } catch {}
  return null;
}

function decryptMegaPlaySourceDynamic(value, script) {
  if (!value || !script) return null;
  const encrypted = Buffer.from(value, "base64url");
  if (!encrypted.length || encrypted.length % 16) return null;
  const values = getScriptStrings(script).filter((item) => Buffer.byteLength(item) > 0 && Buffer.byteLength(item) <= 32);
  const ivs = values.filter((item) => Buffer.byteLength(item) === 16);
  for (const keyValue of values) {
    const key = Buffer.alloc(32);
    Buffer.from(keyValue).copy(key);
    for (const ivValue of ivs) {
      try {
        const decipher = crypto.createDecipheriv("aes-256-cbc", key, Buffer.from(ivValue));
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        const data = JSON.parse(decrypted.toString("utf8"));
        const source = data?.file ?? data?.url;
        if (typeof source === "string" && source) return source;
      } catch {}
    }
  }
  return null;
}

async function fetchText(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) throw new Error(`MegaPlay HTTP ${response.status}: ${url}`);
  return response.text();
}

async function fetchJson(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) throw new Error(`MegaPlay HTTP ${response.status}: ${url}`);
  return response.json();
}

export function canExtractMegaPlay(url) {
  return /megaplay\.[^/]+\/stream\//i.test(String(url));
}

export async function extractMegaPlayDetails(embedUrl, { fetchImpl = fetch, userAgent = DEFAULT_USER_AGENT, referer } = {}) {
  const pageUrl = new URL(String(embedUrl));
  const pageHeaders = {
    "User-Agent": userAgent,
    "Accept": "text/html,*/*",
    "Referer": referer ?? `${pageUrl.origin}/`,
  };
  const pageHtml = await fetchText(fetchImpl, pageUrl, pageHeaders);
  const fileId = pageHtml.match(/data-id=["']([^"']+)["']/i)?.[1];
  if (!fileId) throw new Error(`MegaPlay file id not found: ${embedUrl}`);

  const sourceHeaders = {
    "User-Agent": userAgent,
    "Accept": "application/json,*/*",
    "Referer": pageUrl.href,
    "X-Requested-With": "XMLHttpRequest",
  };

  // s=tcdn is REQUIRED on MegaPlay for valid 200 .m3u8 playback
  let metaData = null;
  let decryptedUrl = null;

  try {
    const tcdnUrl = new URL("/stream/getSources", pageUrl.origin);
    tcdnUrl.searchParams.set("id", fileId);
    tcdnUrl.searchParams.set("s", "tcdn");
    const tcdnData = await fetchJson(fetchImpl, tcdnUrl.href, sourceHeaders);
    if (tcdnData?.enc) {
      decryptedUrl = decryptMegaPlayPayload(tcdnData.enc);
      if (decryptedUrl) {
        metaData = tcdnData;
      }
    } else if (tcdnData?.sources?.file) {
      decryptedUrl = tcdnData.sources.file;
      metaData = tcdnData;
    }
  } catch {}

  // Fallback to default getSources without s=tcdn if tcdn failed
  if (!decryptedUrl) {
    try {
      const defUrl = new URL("/stream/getSources", pageUrl.origin);
      defUrl.searchParams.set("id", fileId);
      const defData = await fetchJson(fetchImpl, defUrl.href, sourceHeaders);
      if (defData?.enc) {
        decryptedUrl = decryptMegaPlayPayload(defData.enc);
        if (decryptedUrl) metaData = defData;
      } else if (defData?.sources?.file) {
        decryptedUrl = defData.sources.file;
        metaData = defData;
      }
    } catch {}
  }

  // Fallback to script scraping if static key didn't work
  if (!decryptedUrl) {
    const scriptUrls = [...pageHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map((match) => new URL(match[1], pageUrl).href);
    const scripts = await Promise.all(scriptUrls.map(async (url) => {
      try { return await fetchText(fetchImpl, url, { "User-Agent": userAgent, "Referer": pageUrl.href }); } catch { return null; }
    }));
    const script = scripts.find((value) => value && /getSources/i.test(value));
    if (script) {
      const { legacy, modern } = getMegaPlayRoutes(script);
      const [modernData, legacyData] = await Promise.all([
        modern ? fetchJson(fetchImpl, `${pageUrl.origin}/${modern.replace(/^\//, "")}?id=${fileId}&s=tcdn`, sourceHeaders).catch(() => null) : null,
        legacy ? fetchJson(fetchImpl, `${pageUrl.origin}/${legacy.replace(/^\//, "")}?id=${fileId}&s=tcdn`, sourceHeaders).catch(() => null) : null,
      ]);
      const legUrl = legacyData?.sources?.file ?? decryptMegaPlaySourceDynamic(legacyData?.enc, script);
      if (legUrl) {
        decryptedUrl = legUrl;
        metaData = legacyData;
      } else if (modernData?.sources?.file) {
        decryptedUrl = modernData.sources.file;
        metaData = modernData;
      }
    }
  }

  if (!decryptedUrl) {
    throw new Error(`MegaPlay response has no playable source for: ${embedUrl}`);
  }

  const sources = [
    { url: decryptedUrl, variant: "tcdn" }
  ];

  const tracks = Array.isArray(metaData?.tracks) ? metaData.tracks : [];
  const intro = metaData?.intro ?? null;
  const outro = metaData?.outro ?? null;

  return {
    origin: pageUrl.origin,
    sources,
    tracks,
    intro,
    outro,
  };
}

export async function extractMegaPlay(embedUrl, options = {}) {
  const details = await extractMegaPlayDetails(embedUrl, options);
  return details.sources.map((source) => source.url);
}

