import { getMedia } from '../core/anilist.js';
import { extractMegaPlayDetails } from "../extractors/megaplay.js";

const ANIKOTO = "https://anikototv.to";
const MAPPER = "https://mapper.nekostream.site/api/mal";
const ANIZIP = "https://api.ani.zip/mappings";
const SPOOF_REF = "https://hianimes.re/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LANG_MAP = {
  en: "en", english: "en", ja: "ja", japanese: "ja",
  fr: "fr", french: "fr", de: "de", german: "de",
  es: "es", spanish: "es", pt: "pt", portuguese: "pt"
};

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function httpGet(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*", ...headers } });
  if (!res.ok) {
    const _raw = await res.text().catch(() => null);
    const _e = new Error(`HTTP ${res.status} fetching ${url}`);
    _e.rawBody = _raw;
    throw _e;
  }
  return res.text();
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,*/*", ...headers } });
  if (!res.ok) {
    const _raw = await res.text().catch(() => null);
    const _e = new Error(`HTTP ${res.status} fetching ${url}`);
    _e.rawBody = _raw;
    throw _e;
  }
  return res.json();
}

const MODIFIERS = [
  "ova", "movie", "special", "specials", "tales", "journal", "part", "season", "kanwa", "spin-off", "theatre"
];

function scoreCandidate(cand, primaryEn, primaryRom, synonyms) {
  let score = 0;
  const candNameNorm = normalize(cand.name);
  const candJpNorm   = normalize(cand.jp);
  const candSlugNorm = normalize(cand.slug);

  const normEn  = normalize(primaryEn);
  const normRom = normalize(primaryRom);

  if (normEn && candNameNorm === normEn) score += 1000;
  if (normRom && candNameNorm === normRom) score += 900;
  if (normRom && candJpNorm === normRom) score += 800;

  const targetText = `${primaryEn || ""} ${primaryRom || ""} ${(synonyms || []).join(" ")}`.toLowerCase();
  
  for (const mod of MODIFIERS) {
    const candHasMod = candNameNorm.includes(mod) || candSlugNorm.includes(mod);
    const targetHasMod = targetText.includes(mod);
    if (candHasMod && !targetHasMod) {
      score -= 300;
    }
  }

  for (const t of [primaryEn, primaryRom, ...(synonyms || [])]) {
    const normT = normalize(t);
    if (!normT || normT.length < 3) continue;

    if (candNameNorm === normT) score += 200;
    else if (candNameNorm.startsWith(normT) || normT.startsWith(candNameNorm)) score += 80;
    else if (candNameNorm.includes(normT) || normT.includes(candNameNorm)) score += 40;

    if (candJpNorm && candJpNorm === normT) score += 100;
  }

  const lengthDiff = Math.abs(candNameNorm.length - (normEn || normRom || "").length);
  score -= lengthDiff * 2;

  return score;
}

async function searchAnikoto(query) {
  const searchHtml = await httpGet(`${ANIKOTO}/filter?keyword=${encodeURIComponent(query)}`, { Referer: `${ANIKOTO}/` });
  const candidates = [];
  
  const re = /<a\s+class="name d-title"\s+href="https:\/\/anikototv\.to\/watch\/([^"/]+)(?:\/ep-\d+)?"[^>]*data-jp="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(searchHtml)) !== null) {
    const slug = m[1];
    const jp = m[2].trim();
    const name = m[3].replace(/<[^>]*>/g, "").trim();
    candidates.push({ slug, name, jp });
  }

  if (!candidates.length) {
    const reFallback = /<a\s+href="https:\/\/anikototv\.to\/watch\/([^"/]+)(?:\/ep-\d+)?"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = reFallback.exec(searchHtml)) !== null) {
      candidates.push({ slug: m[1], name: m[1], jp: "" });
    }
  }

  const seen = new Set();
  return candidates.filter(c => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });
}

async function findAnikotoShow(media) {
  const primaryEn = media.title?.english;
  const primaryRom = media.title?.romaji;
  const synonyms = media.synonyms || [];

  const keywords = [...new Set([primaryEn, primaryRom, ...synonyms].filter(Boolean))];
  const allCandidatesMap = new Map();

  for (const k of keywords.slice(0, 5)) {
    const res = await searchAnikoto(k).catch(() => []);
    for (const c of res) {
      allCandidatesMap.set(c.slug, c);
    }
  }

  const candidates = Array.from(allCandidatesMap.values());
  if (!candidates.length) {
    throw new Error(`No results found on Anikoto for: ${primaryEn || primaryRom}`);
  }

  const scored = candidates.map(c => ({
    ...c,
    score: scoreCandidate(c, primaryEn, primaryRom, synonyms)
  })).sort((a, b) => b.score - a.score);

  const chosen = scored[0];
  const watchHtml = await httpGet(`${ANIKOTO}/watch/${chosen.slug}`, { Referer: `${ANIKOTO}/` });
  const showIdMatch = watchHtml.match(/data-id="(\d+)"/);
  if (!showIdMatch) throw new Error(`Could not find show ID for slug: ${chosen.slug}`);

  return { slug: chosen.slug, showId: showIdMatch[1], title: chosen.name };
}

function mapTrack(t, source) {
  const label = t.label ?? "";
  const langKey = label.toLowerCase().split(" ")[0];
  return {
    url: t.file,
    label: label || "English",
    srclang: LANG_MAP[langKey] ?? "en",
    default: t.default ?? false,
    source
  };
}

async function extractEmbedSource(embedUrl) {
  try {
    return await extractMegaPlayDetails(embedUrl, { userAgent: UA, referer: SPOOF_REF });
  } catch (e) {
    return null;
  }
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media || await getMedia(anilistId);
  if (!media) throw new Error(`Could not resolve media for AniList ID: ${anilistId}`);

  const [show, anizipRes] = await Promise.all([
    findAnikotoShow(media),
    ctx.anizip
      ? Promise.resolve(ctx.anizip)
      : getJSON(`${ANIZIP}?anilist_id=${anilistId}`).catch(() => null)
  ]);

  const listJson = await getJSON(`${ANIKOTO}/ajax/episode/list/${show.showId}`, {
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${ANIKOTO}/watch/${show.slug}`
  });

  const html = listJson.result || "";
  const sub = [];
  const dub = [];

  let firstMal = media.idMal || null;

  const re = /<a\s+[^>]*data-id="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const inner = m[2];
    const getAttr = (attr) => {
      const x = tag.match(new RegExp(`data-${attr}="([^"]*)"`));
      return x ? x[1] : "";
    };

    const numStr = getAttr("num");
    if (!numStr) continue;
    const num = parseInt(numStr);
    const hasSub = getAttr("sub") === "1";
    const hasDub = getAttr("dub") === "1";
    const malAttr = getAttr("mal");
    if (!firstMal && malAttr) firstMal = parseInt(malAttr);

    const titleMatch = inner.match(/<span class="d-title"[^>]*>([\s\S]*?)<\/span>/);
    const parsedTitle = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : "";
    const epTitle = parsedTitle || `Episode ${num}`;

    const azEp = anizipRes?.episodes?.[String(num)] ?? {};
    const img = azEp.image || null;
    const desc = azEp.overview || azEp.summary || null;
    const airDate = azEp.airDate || azEp.airdate || null;

    const base = {
      number: num,
      title: epTitle,
      duration: null,
      filler: false,
      uncensored: false,
      description: desc,
      image: img,
      airDate: airDate
    };

    if (hasSub) {
      sub.push({
        id: `watch/anikoto/${anilistId}/sub/anikoto-${num}`,
        ...base,
        audio: "sub"
      });
    }
    if (hasDub) {
      dub.push({
        id: `watch/anikoto/${anilistId}/dub/anikoto-${num}`,
        ...base,
        audio: "dub"
      });
    }
  }

  sub.sort((a, b) => a.number - b.number);
  dub.sort((a, b) => a.number - b.number);

  return {
    meta: {
      title: show.title,
      slug: show.slug,
      malId: firstMal,
      source: "anikoto"
    },
    episodes: { sub, dub }
  };
}

const AL_API = "https://api.anilight.live/api";
const AL_SITE = "https://anilight.live";

async function resolveDirectMegaPlay(anilistId, epNum, audio) {
  try {
    const directEmbedUrl = `https://megaplay.buzz/stream/ani/${anilistId}/${epNum}/${audio}?s=tcdn`;
    const extracted = await extractMegaPlayDetails(directEmbedUrl, { userAgent: UA, referer: "https://megaplay.buzz/" });
    if (!extracted?.sources?.length) return null;

    const subs = (extracted.tracks || []).map(t => mapTrack(t, "MegaPlay HD"));
    const hls = extracted.sources[0]?.url;
    if (!hls) return null;

    return {
      stream: {
        url: hls,
        type: "hls",
        server: "MegaPlay (Direct HD)",
        embedUrl: directEmbedUrl,
        referer: "https://megaplay.buzz/",
        subtitles: subs,
        intro: (extracted.intro?.start || extracted.intro?.end) ? { start: Number(extracted.intro.start) || 0, end: Number(extracted.intro.end) || 0 } : null,
        outro: (extracted.outro?.start || extracted.outro?.end) ? { start: Number(extracted.outro.start) || 0, end: Number(extracted.outro.end) || 0 } : null,
        priority: 6,
        isActive: true
      },
      subtitles: subs
    };
  } catch {
    return null;
  }
}

async function resolveAnilightSources(media, epNum, audio) {
  const titles = [media.title?.english, media.title?.romaji, ...(media.synonyms || [])].filter(Boolean);
  const headers = {
    "User-Agent": UA,
    "Referer": `${AL_SITE}/`,
    "Origin": AL_SITE,
    "Accept": "application/json"
  };

  const streams = [];
  const subtitles = [];

  for (const query of titles.slice(0, 3)) {
    try {
      const searchRes = await fetch(`${AL_API}/search?q=${encodeURIComponent(query)}`, { headers });
      if (!searchRes.ok) continue;
      const items = await searchRes.json();
      if (!Array.isArray(items) || !items.length) continue;

      let match = items.find(x => x.anilistId === media.id || (media.idMal && x.idMal === media.idMal));
      if (!match) {
        const normQuery = normalize(query);
        match = items.find(x => {
          const t = x.title || {};
          const en = normalize(t.english);
          const ro = normalize(t.romaji);
          return en === normQuery || ro === normQuery || en.includes(normQuery) || normQuery.includes(en);
        }) || items[0];
      }
      if (!match?.slug) continue;

      const watchRes = await fetch(`${AL_API}/watch/${match.slug}`, { headers });
      if (!watchRes.ok) continue;
      const watchData = await watchRes.json();
      const wid = watchData.id;
      const providers = (audio === "dub" ? watchData?.servers?.dubProviders : watchData?.servers?.subProviders) || [];

      const provPromises = providers.slice(0, 7).map(async (prov) => {
        try {
          const srcRes = await fetch(`${AL_API}/sources?id=${wid}&epNum=${epNum}&type=${audio}&providerId=${prov.id}`, { headers });
          if (!srcRes.ok) return;
          const srcData = await srcRes.json();
          const provName = prov.name || prov.id || "Server";
          const provTip = prov.tip ? ` (${prov.tip})` : "";
          const isSoft = prov.tip?.toLowerCase().includes("soft");
          const serverName = `Anilight - ${provName.toUpperCase()}${provTip}`;

          let intro = null, outro = null;
          for (const chap of (srcData.chapters || [])) {
            const t = (chap.title || "").toLowerCase();
            if (t.includes("intro") || t.includes("op")) intro = { start: Number(chap.start) || 0, end: Number(chap.end) || 0 };
            if (t.includes("outro") || t.includes("ed")) outro = { start: Number(chap.start) || 0, end: Number(chap.end) || 0 };
          }

          const provSubs = [];
          for (const tr of (srcData.tracks || [])) {
            const u = tr.file || tr.url;
            if (!u || (tr.kind && tr.kind !== "captions")) continue;
            provSubs.push({
              url: u,
              label: tr.label || tr.lang || "English",
              srclang: (tr.lang || "en").slice(0, 3).toLowerCase(),
              default: Boolean(tr.default),
              source: serverName
            });
          }

          for (const s of (srcData.sources || [])) {
            if (!s.url) continue;
            const isHls = s.url.includes(".m3u8") || s.type === "hls";
            const isEmbed = !isHls && (s.url.includes("/e/") || s.url.includes("embed"));
            streams.push({
              url: s.url,
              type: isHls ? "hls" : (isEmbed ? "embed" : "direct"),
              server: serverName,
              referer: `${AL_SITE}/`,
              quality: s.quality || "auto",
              subtitles: provSubs,
              intro,
              outro,
              priority: isSoft ? 5 : (isHls ? 4 : 3),
              isActive: false
            });
          }
          subtitles.push(...provSubs);
        } catch {}
      });

      await Promise.allSettled(provPromises);
      if (streams.length > 0) break;
    } catch {}
  }

  return { streams, subtitles };
}

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  if (audio !== "sub" && audio !== "dub") {
    return jsonResponse({ error: "audio must be sub or dub" }, 400);
  }

  const media = ctx.media || await getMedia(anilistId);
  if (!media) {
    return jsonResponse({ error: `Could not resolve media for AniList ID: ${anilistId}` }, 400);
  }

  // Launch direct MegaPlay and Anilight multi-server queries in parallel with Anikoto TV
  const [directMpRes, anilightRes, anikotoShowRes] = await Promise.allSettled([
    resolveDirectMegaPlay(anilistId, epNum, audio),
    resolveAnilightSources(media, epNum, audio),
    findAnikotoShow(media).catch(() => null)
  ]);

  const directMp = directMpRes.status === "fulfilled" ? directMpRes.value : null;
  const anilight = anilightRes.status === "fulfilled" ? anilightRes.value : null;
  const show = anikotoShowRes.status === "fulfilled" ? anikotoShowRes.value : null;

  const streams = [];
  const subtitles = [];
  const downloads = [];

  const serverSeen = new Set();
  const subSeen = new Set();
  const dlSeen = new Set();

  // 1. Add Direct MegaPlay stream if available (Top priority)
  if (directMp?.stream) {
    streams.push(directMp.stream);
    serverSeen.add(directMp.stream.server);
    for (const sub of directMp.subtitles) {
      if (!subSeen.has(sub.url)) {
        subSeen.add(sub.url);
        subtitles.push(sub);
      }
    }
  }

  // 2. Resolve Anikoto TV servers
  let malIdNum = media.idMal || null;

  if (show?.showId) {
    try {
      const listJson = await getJSON(`${ANIKOTO}/ajax/episode/list/${show.showId}`, {
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${ANIKOTO}/watch/${show.slug}`
      });

      const html = listJson.result || "";
      let targetEp = null;
      const re = /<a\s+[^>]*data-id="([^"]*)"[^>]*>/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const tag = m[0];
        const getAttr = (attr) => {
          const x = tag.match(new RegExp(`data-${attr}="([^"]*)"`));
          return x ? x[1] : "";
        };
        if (parseInt(getAttr("num")) === epNum) {
          targetEp = {
            ids: getAttr("ids"),
            mal: getAttr("mal"),
            slug: getAttr("slug"),
            timestamp: getAttr("timestamp")
          };
          break;
        }
      }

      if (targetEp?.ids) {
        if (!malIdNum && targetEp.mal) malIdNum = parseInt(targetEp.mal);

        const [serverDataRes, mapperRes] = await Promise.allSettled([
          getJSON(`${ANIKOTO}/ajax/server/list?servers=${encodeURIComponent(targetEp.ids)}`, {
            "X-Requested-With": "XMLHttpRequest",
            Referer: `${ANIKOTO}/`
          }),
          (targetEp.mal && targetEp.slug && targetEp.timestamp)
            ? getJSON(`${MAPPER}/${targetEp.mal}/${targetEp.slug}/${targetEp.timestamp}`, { Referer: `${ANIKOTO}/` })
            : Promise.resolve(null)
        ]);

        const serverData = serverDataRes.status === "fulfilled" ? serverDataRes.value : null;
        const mapperData = mapperRes.status === "fulfilled" ? mapperRes.value : null;

        const serverHtml = serverData?.result || "";
        const serverItems = [];
        const downloadItems = [];

        const typeRe = /<div class="type" data-type="([^"]+)">([\s\S]*?)<\/ul>\s*<\/div>/g;
        let typeM;
        while ((typeM = typeRe.exec(serverHtml)) !== null) {
          const typeName = typeM[1];
          for (const li of typeM[2].matchAll(/<li\s+([^>]*data-link-id[^>]*)>([\s\S]*?)<\/li>/g)) {
            const linkId = li[1].match(/data-link-id="([^"]+)"/)?.[1];
            const name = li[2].replace(/<[^>]+>/g, "").trim();
            if (!linkId) continue;

            if (typeName === "dl" || name.toLowerCase().includes("download") || name.toLowerCase().includes("kiwi")) {
              downloadItems.push({ linkId, name });
            } else if (typeName === audio) {
              serverItems.push({ linkId, name });
            }
          }
        }

        if (mapperData) {
          for (const [sKey, sObj] of Object.entries(mapperData)) {
            if (sKey === "status") continue;
            const cleanName = sKey.replace(/[-_]+$/, "").trim();
            if (sObj?.[audio]?.url) {
              serverItems.push({ linkId: sObj[audio].url, name: cleanName });
            }
            if (sObj?.[audio]?.download) {
              for (const [dLabel, dUrl] of Object.entries(sObj[audio].download)) {
                if (dUrl && typeof dUrl === "string") {
                  downloadItems.push({ url: dUrl, name: cleanName });
                }
              }
            }
          }
        }

        for (const item of serverItems) {
          const resolved = item.linkId.startsWith("http")
            ? { result: { url: item.linkId } }
            : await getJSON(`${ANIKOTO}/ajax/server?get=${encodeURIComponent(item.linkId)}`, {
                "X-Requested-With": "XMLHttpRequest",
                Referer: `${ANIKOTO}/`
              }).catch(() => null);

          const embedUrl = resolved?.result?.url;
          if (!embedUrl) continue;

          let serverIntro = { start: 0, end: 0 };
          let serverOutro = { start: 0, end: 0 };

          if (resolved?.result?.skip_data?.intro?.length === 2) {
            const [s, e] = resolved.result.skip_data.intro;
            if (s || e) serverIntro = { start: Number(s) || 0, end: Number(e) || 0 };
          }
          if (resolved?.result?.skip_data?.outro?.length === 2) {
            const [s, e] = resolved.result.skip_data.outro;
            if (s || e) serverOutro = { start: Number(s) || 0, end: Number(e) || 0 };
          }

          const hlsSources = [];

          if (embedUrl.includes("#aHR0c")) {
            const b64 = embedUrl.split("#")[1];
            try {
              const decodedUrl = atob(b64);
              if (decodedUrl.includes(".m3u8")) {
                hlsSources.push({ url: decodedUrl, variant: null });
              }
            } catch {}
          }

          const extracted = await extractEmbedSource(embedUrl);
          const itemSubs = [];

          if (extracted?.sources?.length) {
            for (const source of extracted.sources) {
              if (!hlsSources.some((cand) => cand.url === source.url)) hlsSources.push(source);
            }

            for (const t of extracted.tracks ?? []) {
              const mapped = mapTrack(t, item.name);
              itemSubs.push(mapped);
              if (!subSeen.has(mapped.url)) {
                subSeen.add(mapped.url);
                subtitles.push(mapped);
              }
            }

            if (extracted.intro?.start || extracted.intro?.end) {
              serverIntro = { start: Number(extracted.intro.start) || 0, end: Number(extracted.intro.end) || 0 };
            }
            if (extracted.outro?.start || extracted.outro?.end) {
              serverOutro = { start: Number(extracted.outro.start) || 0, end: Number(extracted.outro.end) || 0 };
            }
          }

          const serverLabel = `Anikoto - ${item.name}`;

          if (hlsSources.length) {
            for (const source of hlsSources) {
              const streamObj = {
                url: source.url,
                type: "hls",
                server: serverLabel,
                embedUrl,
                referer: extracted?.origin ? `${extracted.origin}/` : `${new URL(embedUrl).origin}/`,
                subtitles: itemSubs,
                priority: streams.length === 0 ? 5 : 4,
                isActive: streams.length === 0
              };
              if (source.variant) streamObj.variant = source.variant;
              if (serverIntro.start || serverIntro.end) streamObj.intro = serverIntro;
              if (serverOutro.start || serverOutro.end) streamObj.outro = serverOutro;
              streams.push(streamObj);
            }
          } else {
            const streamObj = {
              url: embedUrl,
              type: "embed",
              server: serverLabel,
              referer: `${new URL(embedUrl).origin}/`,
              priority: 3,
              isActive: streams.length === 0
            };
            if (serverIntro.start || serverIntro.end) streamObj.intro = serverIntro;
            if (serverOutro.start || serverOutro.end) streamObj.outro = serverOutro;
            streams.push(streamObj);
          }
        }

        for (const dl of downloadItems) {
          let dlUrl = dl.url;
          if (!dlUrl && dl.linkId) {
            const resolved = await getJSON(`${ANIKOTO}/ajax/server?get=${encodeURIComponent(dl.linkId)}`, {
              "X-Requested-With": "XMLHttpRequest",
              Referer: `${ANIKOTO}/`
            }).catch(() => null);
            dlUrl = resolved?.result?.url;
          }

          if (dlUrl && !dlSeen.has(dlUrl)) {
            dlSeen.add(dlUrl);
            downloads.push({
              url: dlUrl,
              label: dl.name
            });
          }
        }
      }
    } catch {}
  }

  // 3. Add Anilight multi-servers
  if (anilight?.streams?.length) {
    for (const st of anilight.streams) {
      if (!streams.some(s => s.url === st.url)) {
        streams.push(st);
      }
    }
    for (const sub of (anilight.subtitles || [])) {
      if (!subSeen.has(sub.url)) {
        subSeen.add(sub.url);
        subtitles.push(sub);
      }
    }
  }

  // If no streams found across all sources, report 404
  if (!streams.length) {
    return jsonResponse({ error: `Episode ${epNum} not found for show: ${media.title?.english || media.title?.romaji}` }, 404);
  }

  // Sort streams: active first, then highest priority HLS first, embeds last
  streams.sort((a, b) => {
    if (a.type === "hls" && b.type !== "hls") return -1;
    if (b.type === "hls" && a.type !== "hls") return 1;
    return (b.priority || 0) - (a.priority || 0);
  });

  // Ensure first HLS stream is marked active
  let activeSet = false;
  for (const s of streams) {
    if (!activeSet && s.type === "hls") {
      s.isActive = true;
      activeSet = true;
    } else {
      s.isActive = false;
    }
  }
  if (!activeSet && streams.length > 0) {
    streams[0].isActive = true;
  }

  // Ensure unique server labels in UI
  const seenServerNames = new Map();
  for (const s of streams) {
    const base = s.server || "Server";
    const count = (seenServerNames.get(base) || 0) + 1;
    seenServerNames.set(base, count);
    if (count > 1) {
      s.server = `${base} #${count}`;
    }
  }

  const activeStream = streams.find(s => s.isActive) || streams[0];

  return jsonResponse({
    anilistId: parseInt(anilistId),
    malId: malIdNum,
    episode: epNum,
    audio,
    stream_url: activeStream?.url || null,
    streams,
    subtitles,
    downloads,
    headers: {
      "User-Agent": UA,
      "Referer": activeStream?.referer || "https://megaplay.buzz/"
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*"
        }
      });
    }
    try {
      let m = path.match(/^\/watch\/anikoto\/(\d+)\/(sub|dub)\/anikoto-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], parseInt(m[3]));

      m = path.match(/^\/episodes\/anikoto\/(\d+)\/?$/);
      if (m) {
        const data = await getEpisodes(parseInt(m[1]));
        return jsonResponse(data);
      }
      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message, stack: err.stack }, 500);
    }
  }
};
