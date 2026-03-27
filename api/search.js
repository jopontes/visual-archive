// Visual Archive — Serverless Search Function (Vercel)
// Queries 10 institutional APIs + Meilisearch static index in parallel.
// NOTE: Rijksmuseum removed in March 2026 — old API (rijksmuseum.nl/api) returned HTTP 410 Gone.
// New API (data.rijksmuseum.nl) only supports filters (creator=, type=), not free-text search.
// NOTE: Europeana removed — API was very noisy with non-visual items, low quality results.
//
// Parameters:
//   ?q=TERM                — search term (required unless discover=1)
//   ?discover=1            — returns random results from a curated term set (no q needed)
//   ?sources=vam,artic,met — comma-separated source filter (default: all)
//   ?category=film         — filter static index by category (film|art|photography|design|typography)
//   ?offset=0              — pagination offset (default 0; when >0 only queries Meilisearch)
//   ?limit=60              — results per page (default 60)
//   ?mood=melancholic,dramatic  — filter by ai_mood (OR within)
//   ?lighting=low-key,neon      — filter by ai_lighting (OR within)
//   ?shot_type=close-up         — filter by ai_shot_type (OR within)
//   ?year_from=1850             — filter year >= N
//   ?year_to=1920               — filter year <= N

const SOURCE_KEYS = [
  'vam', 'artic', 'smithsonian', 'met',
  'wellcome', 'nasa', 'nypl', 'bhl',
  'meilisearch',  // ← static scraped databases
];

// Scraped database keys → their source_slug in Meilisearch
const MEILI_SLUG_MAP = {
  filmgrab:          'filmgrab',
  booooooom:         'booooooom',
  directors_notes:   'directors_notes',
  directors_library: 'directors_library',
  beyond_short:      'beyond_the_short',
  wga:               'wga',
  mb_collection:     'mb_collection',
  letterform:        'letterform',
  peoples_gd:        'peoples_gd',
  vimeo:             'vimeo_staff_picks',
  fonts_in_use:          'fonts_in_use',
  icp:                   'icp',
  duke:                  'duke',
  aperture:              'aperture',
  bjp_1854:              'bjp_1854',
  ikonographia:          'ikonographia',
  american_sign_museum:  'american_sign_museum',
};
const MEILI_KEYS = Object.keys(MEILI_SLUG_MAP);
const ALL_KNOWN_KEYS = [...SOURCE_KEYS, ...MEILI_KEYS];

// Sources included by default (no ?sources= param).
// NASA and Wikimedia Commons are opt-in only (too noisy for most searches).
const DEFAULT_SOURCES = [
  'vam', 'artic', 'smithsonian', 'met',
  'wellcome', 'nypl',
  'meilisearch',
];

const DISCOVER_TERMS = [
  // colours & light
  'gold', 'red', 'blue', 'black', 'white', 'shadow', 'darkness', 'neon',
  'smoke', 'fire', 'fog', 'reflection', 'silhouette', 'glow', 'grain',

  // emotions & mood
  'melancholy', 'solitude', 'grief', 'joy', 'fear', 'desire', 'tenderness',
  'rage', 'nostalgia', 'ecstasy', 'stillness', 'tension', 'longing',

  // body & gesture
  'face', 'hands', 'gaze', 'crowd', 'sleep', 'dance', 'embrace', 'fall',

  // cinematic & photographic
  'close-up', 'night', 'rain', 'street', 'window', 'door', 'staircase',
  'mirror', 'empty room', 'car', 'chase', 'waiting',

  // nature & environment
  'storm', 'water', 'desert', 'forest', 'sky', 'ocean', 'ice', 'mud',
  'ruins', 'overgrown', 'coast', 'mountain',

  // objects & things
  'clock', 'bottle', 'table', 'chair', 'book', 'cloth', 'wire', 'rope',
  'food', 'machine', 'paper', 'glass', 'fabric',

  // concepts & abstractions
  'pattern', 'grid', 'spiral', 'texture', 'decay', 'memory', 'ritual',
  'labor', 'war', 'childhood', 'ceremony', 'propaganda', 'utopia',

  // classic art terms (kept but reduced)
  'portrait', 'still life', 'botanical', 'anatomy', 'costume', 'map',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-secret');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const secret = process.env.API_SECRET;
  if (secret && req.headers['x-api-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { q, discover, sources: sourcesParam, offset: offsetParam, limit: limitParam,
          mood, lighting, shot_type, year_from, year_to } = req.query;
  const offset = Math.max(0, parseInt(offsetParam) || 0);
  const limit  = Math.min(200, Math.max(1, parseInt(limitParam) || 60));

  // Resolve active sources — map scraped DB keys to 'meilisearch' + collect slugs
  let activeSources;
  let meiliSlugs = [];  // specific source_slugs to filter in Meilisearch
  if (sourcesParam) {
    const requested = sourcesParam.split(',').map(s => s.trim()).filter(s => ALL_KNOWN_KEYS.includes(s));
    const apiSources = requested.filter(s => SOURCE_KEYS.includes(s));
    const scrapedKeys = requested.filter(s => MEILI_KEYS.includes(s));
    meiliSlugs = scrapedKeys.map(k => MEILI_SLUG_MAP[k]);
    // If any scraped DB is selected, ensure 'meilisearch' is in active sources
    if (scrapedKeys.length > 0 && !apiSources.includes('meilisearch')) {
      apiSources.push('meilisearch');
    }
    activeSources = [...new Set(apiSources)];
  } else {
    activeSources = DEFAULT_SOURCES;
  }

  // Resolve search term
  let term;
  if (discover === '1') {
    // Pick 2 distinct random terms — multiplies variety exponentially
    const shuffle = [...DISCOVER_TERMS].sort(() => Math.random() - 0.5);
    const picked = shuffle.slice(0, 2);
    term = encodeURIComponent(picked.join(' '));
  } else {
    if (!q || !q.trim()) return res.status(400).json({ error: 'Missing parameter: q' });
    term = encodeURIComponent(q.trim());
  }

  // Build fetch promises for active sources only
  const { category } = req.query;

  // Parse comma-separated filter values
  const parseCsv = (v) => v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
  const meiliFilters = {
    category,
    sourceSlugs: meiliSlugs,
    moods:      parseCsv(mood),
    lighting:   parseCsv(lighting),
    shotTypes:  parseCsv(shot_type),
    yearFrom:   parseInt(year_from) || null,
    yearTo:     parseInt(year_to) || null,
    offset,
    limit,
  };

  // When offset > 0 (pagination), only query Meilisearch (APIs don't support offset)
  const skipApis = offset > 0;

  const fetchers = {
    vam:         () => skipApis ? [] : searchVAMuseum(term),
    artic:       () => skipApis ? [] : searchArtic(term),
    smithsonian: () => skipApis ? [] : searchSmithsonian(term),
    met:         () => skipApis ? [] : searchMet(term),
    wellcome:    () => skipApis ? [] : searchWellcome(term),
    nasa:        () => skipApis ? [] : searchNASA(term),
    nypl:        () => skipApis ? [] : searchNYPL(term),
    bhl:         () => skipApis ? [] : searchBHL(term),
    meilisearch: () => searchMeilisearch(term, meiliFilters),
  };

  const results = await Promise.allSettled(
    activeSources.map(key => fetchers[key]())
  );

  // ── Reciprocal Rank Fusion (RRF) ──
  // Each source returns results in relevance order. RRF assigns a score
  // based on rank position: score = weight / (k + rank). This ensures
  // top results from ALL sources cluster at the top, regardless of which
  // API they came from. Source weights bias toward curated creative archives.
  const RRF_K = 60;
  const SOURCE_WEIGHTS = {
    meilisearch:  1.5,   // Curated creative databases — core value
    artic:        1.2,   // Excellent metadata + high-res
    vam:          1.0,   // Reliable institutional baselines
    met:          1.0,
    smithsonian:  1.0,
    wellcome:     0.9,   // Slightly niche
    nypl:         0.8,   // Slow, often partial
    nasa:         0.3,   // Opt-in only
    bhl:          0.3,   // Opt-in only
  };

  // Non-image extension filter — catch PDFs, DjVu, etc. that slip through
  const NON_IMAGE_EXTS = ['.pdf', '.djvu', '.epub', '.doc', '.docx', '.ps', '.eps'];

  // Tag each source's items with _sourceKey and _rank, then flatten
  const allItems = [];
  results.forEach((r, idx) => {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
    const sourceKey = activeSources[idx];
    r.value.forEach((item, rank) => {
      if (!item || !item.image_url) return;
      const urlPath = item.image_url.toLowerCase().split('?')[0];
      if (NON_IMAGE_EXTS.some(ext => urlPath.endsWith(ext))) return;
      item._sourceKey = sourceKey;
      item._rank = rank;
      allItems.push(item);
    });
  });

  let items;
  if (discover === '1') {
    // Discover mode: random shuffle
    items = allItems.sort(() => Math.random() - 0.5);
  } else {
    // Apply RRF scoring and sort
    allItems.forEach(item => {
      const w = SOURCE_WEIGHTS[item._sourceKey] || 1.0;
      item._rrfScore = w / (RRF_K + item._rank);
    });
    items = allItems.sort((a, b) => b._rrfScore - a._rrfScore);
  }

  // Deduplicate: same image_url from multiple sources (e.g. V&A API + Meilisearch static)
  // Keep the first occurrence (highest RRF score / best rank)
  const seenUrls = new Set();
  const seenIds  = new Set();
  items = items.filter(item => {
    const urlKey = item.image_url || '';
    const idKey  = item.id ? String(item.id) : '';
    if (urlKey && seenUrls.has(urlKey)) return false;
    if (idKey  && seenIds.has(idKey))   return false;
    if (urlKey) seenUrls.add(urlKey);
    if (idKey)  seenIds.add(idKey);
    return true;
  });

  // Extract Meilisearch total for pagination info
  const meiliResult = results.find((r, i) => activeSources[i] === 'meilisearch');
  const estimatedTotal = meiliResult?.status === 'fulfilled' && meiliResult.value?._meta?.estimatedTotalHits
    ? meiliResult.value._meta.estimatedTotalHits : null;

  // Strip _meta from meilisearch results (it was attached for internal use)
  const maxItems = skipApis ? limit : 150;
  return res.status(200).json({
    items: items.slice(0, maxItems),
    total: estimatedTotal,
    offset,
  });
}

// ── 1. V&A Museum ──────────────────────────────────────────────
async function searchVAMuseum(term) {
  try {
    const res = await fetch(
      `https://api.vam.ac.uk/v2/objects/search?q=${term}&images_exist=1&page_size=12`
    );
    const data = await res.json();
    if (!data.records?.length) return [];
    return data.records
      .filter(item => item._primaryImageId)
      .map(item => ({
        id:          `va-${item.systemNumber}`,
        title:       item._primaryTitle || 'Untitled',
        image_url:   `https://framemark.vam.ac.uk/collections/${item._primaryImageId}/full/600,/0/default.jpg`,
        source_url:  `https://collections.vam.ac.uk/item/${item.systemNumber}`,
        institution: 'V&A Museum',
        date:        item._primaryDate || '',
        creator:     item._primaryMaker?.name || '',
        medium:      item._primaryMaterials || '',
        object_type: item._objectType || '',
        place:       item._primaryPlace || '',
      }));
  } catch { return []; }
}

// ── 2. Art Institute of Chicago ────────────────────────────────
async function searchArtic(term) {
  try {
    const res = await fetch(
      `https://api.artic.edu/api/v1/artworks/search?q=${term}&fields=id,title,image_id,date_display,artist_display,medium_display,place_of_origin,style_title,classification_title&limit=12`
    );
    const data = await res.json();
    if (!data.data?.length) return [];
    return data.data
      .filter(item => item.image_id)
      .map(item => ({
        id:          `artic-${item.id}`,
        title:       item.title || 'Untitled',
        image_url:   `https://www.artic.edu/iiif/2/${item.image_id}/full/400,/0/default.jpg`,
        source_url:  `https://www.artic.edu/artworks/${item.id}`,
        institution: 'Art Institute of Chicago',
        date:        item.date_display || '',
        creator:     item.artist_display || '',
        medium:      item.medium_display || '',
        place:       item.place_of_origin || '',
        style:       item.style_title || '',
        object_type: item.classification_title || '',
      }));
  } catch { return []; }
}

// ── 3. Smithsonian ─────────────────────────────────────────────
// Fix: must use has_media=true&online_media_type=Images, otherwise rows have no online_media.
async function searchSmithsonian(term) {
  const key = process.env.SMITHSONIAN_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://api.si.edu/openaccess/api/v1.0/search?q=${term}&api_key=${key}&rows=24&has_media=true&online_media_type=Images`
    );
    const data = await res.json();
    const rows = data.response?.rows;
    if (!rows?.length) return [];
    const items = [];
    for (const row of rows) {
      try {
        const dnr = row.content?.descriptiveNonRepeating;
        if (!dnr) continue;
        const mediaArray = dnr.online_media?.media;
        const media = Array.isArray(mediaArray)
          ? mediaArray.find(m => m.thumbnail || m.content) : null;
        const image_url = media?.thumbnail || media?.content;
        if (!image_url) continue;
        items.push({
          id:          `si-${row.id}`,
          title:       dnr.title?.content || row.title || 'Untitled',
          image_url,
          source_url:  dnr.record_link || `https://www.si.edu/object/${row.id}`,
          institution: 'Smithsonian',
          date:        row.content?.freetext?.date?.[0]?.content || '',
          creator:     row.content?.freetext?.name?.[0]?.content || '',
          medium:      row.content?.freetext?.physicalDescription?.[0]?.content || '',
        });
        if (items.length >= 12) break;
      } catch { /* skip malformed row */ }
    }
    return items;
  } catch { return []; }
}


// ── 5. Met Museum ──────────────────────────────────────────────
async function searchMet(term) {
  try {
    const searchRes = await fetch(
      `https://collectionapi.metmuseum.org/public/collection/v1/search?q=${term}&hasImages=true`
    );
    const searchData = await searchRes.json();
    if (!searchData.objectIDs?.length) return [];
    const ids = searchData.objectIDs.slice(0, 6);
    const objects = await Promise.allSettled(
      ids.map(id =>
        fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`)
          .then(r => r.json())
      )
    );
    return objects
      .filter(r => r.status === 'fulfilled' && r.value.primaryImageSmall)
      .map(r => ({
        id:          `met-${r.value.objectID}`,
        title:       r.value.title || 'Untitled',
        image_url:   r.value.primaryImageSmall,
        source_url:  r.value.objectURL,
        institution: 'The Met',
        date:        r.value.objectDate || '',
        creator:     r.value.artistDisplayName || '',
        medium:      r.value.medium || '',
        culture:     r.value.culture || '',
        period:      r.value.period || '',
        object_type: r.value.classification || '',
        place:       r.value.country || r.value.region || '',
      }));
  } catch { return []; }
}

// ── 6. Wellcome Collection ─────────────────────────────────────
async function searchWellcome(term) {
  try {
    const res = await fetch(
      `https://api.wellcomecollection.org/catalogue/v2/images?query=${term}&pageSize=12`
    );
    const data = await res.json();
    if (!data.results?.length) return [];
    return data.results
      .filter(item => item.thumbnail?.url)
      .map(item => ({
        id:          `wellcome-${item.id}`,
        title:       item.source?.title || 'Untitled',
        image_url:   item.thumbnail.url.replace('/info.json', '/full/880,/0/default.jpg'),
        source_url:  `https://wellcomecollection.org/works/${item.source?.id || item.id}`,
        institution: 'Wellcome Collection',
        date:        item.source?.productionDates?.[0]?.label || '',
        creator:     item.source?.contributors?.[0]?.agent?.label || '',
        medium:      item.source?.physicalDescription || '',
        object_type: item.source?.format?.label || '',
        description: item.source?.description || '',
      }));
  } catch { return []; }
}

// ── 7. NASA Images & Video Library ────────────────────────────
async function searchNASA(term) {
  try {
    const res = await fetch(
      `https://images-api.nasa.gov/search?q=${term}&media_type=image`
    );
    const data = await res.json();
    const items = data.collection?.items;
    if (!items?.length) return [];
    return items
      .slice(0, 12)
      .filter(item => item.links?.[0]?.href)
      .map(item => {
        const meta = item.data?.[0] || {};
        return {
          id:          `nasa-${meta.nasa_id || item.href}`,
          title:       meta.title || 'Untitled',
          image_url:   item.links[0].href,
          source_url:  meta.nasa_id
            ? `https://images.nasa.gov/details/${meta.nasa_id}`
            : 'https://images.nasa.gov/',
          institution: 'NASA',
          date:        meta.date_created ? meta.date_created.substring(0, 4) : '',
          creator:     meta.center || '',
          medium:      '',
          description: meta.description ? meta.description.substring(0, 300) : '',
          keywords:    Array.isArray(meta.keywords) ? meta.keywords.slice(0, 6).join(', ') : '',
        };
      });
  } catch { return []; }
}


// ── 9. NYPL Digital Collections ───────────────────────────────
// Search returns imageID; image URL built as images.nypl.org/index.php?id={id}&t=q
async function searchNYPL(term) {
  const key = process.env.NYPL_KEY;
  if (!key) return [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://api.repo.nypl.org/api/v2/items/search?q=${term}&publicDomainOnly=true&per_page=12`,
      {
        headers: { 'Authorization': `Token token="${key}"` },
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    const data = await res.json();
    const results = data.nyplAPI?.response?.result;
    if (!results?.length) return [];
    return results
      .filter(item => item.imageID)
      .map(item => {
        const title = Array.isArray(item.title) ? item.title[0] : (item.title || 'Untitled');
        return {
          id:          `nypl-${item.uuid}`,
          title,
          // t=q is ~760px; t=r is ~400px; t=w is full-width
          image_url:   `https://images.nypl.org/index.php?id=${item.imageID}&t=q`,
          source_url:  item.itemLink || `https://digitalcollections.nypl.org/items/${item.uuid}`,
          institution: 'New York Public Library',
          date:        item.captureDate?.substring(0, 4) || item.dateDigitized?.substring(0, 4) || '',
          creator:     '',
          medium:      '',
        };
      });
  } catch { return []; }
}

// ── 11. Meilisearch — Static Scraped Databases ────────────────
// Queries our self-hosted Meilisearch index (hosted on Render.com).
// Covers: FilmGrab, Booooooom TV, Directors Notes, Beyond the Short,
//         Web Gallery of Art, M+B Collection, Letterform Archive,
//         + Duke AdAccess, Fonts In Use, Peoples GD, ICP (when scraped).
//
// Env vars required:
//   MEILI_URL  — e.g. https://visual-archive-search.onrender.com
//   MEILI_KEY  — search-only API key (NOT the master key)
async function searchMeilisearch(term, {
  category, sourceSlugs, moods, lighting, shotTypes,
  yearFrom, yearTo, offset = 0, limit = 60,
} = {}) {
  const meiliUrl = process.env.MEILI_URL;
  const meiliKey = process.env.MEILI_KEY;
  if (!meiliUrl || !meiliKey) return [];

  try {
    // Build filter string — filterable fields: category, source_slug, year, medium,
    // ai_mood, ai_lighting, ai_shot_type, ai_tags, color_palette
    const filters = [];
    if (category) filters.push(`category = "${category}"`);
    if (sourceSlugs?.length) {
      filters.push(`source_slug IN [${sourceSlugs.map(s => `"${s}"`).join(', ')}]`);
    }
    if (moods?.length) {
      filters.push(`ai_mood IN [${moods.map(s => `"${s}"`).join(', ')}]`);
    }
    if (lighting?.length) {
      filters.push(`ai_lighting IN [${lighting.map(s => `"${s}"`).join(', ')}]`);
    }
    if (shotTypes?.length) {
      filters.push(`ai_shot_type IN [${shotTypes.map(s => `"${s}"`).join(', ')}]`);
    }
    if (yearFrom) filters.push(`year >= ${yearFrom}`);
    if (yearTo)   filters.push(`year <= ${yearTo}`);

    const body = {
      q:                    decodeURIComponent(term) === '*' ? '' : decodeURIComponent(term),
      offset,
      limit,
      attributesToRetrieve: [
        'id', 'title', 'creator', 'year', 'medium', 'category',
        'source', 'source_slug', 'description', 'tags',
        'image_url', 'image_index', 'total_images',
        'item_url', 'location', 'dimensions',
        'ai_mood', 'ai_lighting', 'ai_shot_type', 'ai_tags',
      ],
      attributesToHighlight: ['title', 'creator'],
      highlightPreTag:       '<em>',
      highlightPostTag:      '</em>',
      filter:                filters.length ? filters.join(' AND ') : undefined,
    };

    const res = await fetch(
      `${meiliUrl.replace(/\/$/, '')}/indexes/visual_archive/search`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${meiliKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) return [];
    const data = await res.json();

    const items = (data.hits || []).map(hit => ({
      id:          hit.id,
      title:       hit.title || 'Untitled',
      titleHighlighted: hit._formatted?.title || hit.title || 'Untitled',
      image_url:   hit.image_url,
      source_url:  hit.item_url || '',
      institution: hit.source || 'Visual Archive',
      date:        hit.year ? String(hit.year) : '',
      creator:     hit.creator || '',
      creatorHighlighted: hit._formatted?.creator || hit.creator || '',
      medium:      hit.medium || '',
      category:    hit.category || '',
      source_slug: hit.source_slug || '',
      description: hit.description || '',
      tags:        hit.tags || [],
      ai_tags:     hit.ai_tags || [],
      ai_mood:     hit.ai_mood || '',
      ai_lighting: hit.ai_lighting || '',
      ai_shot_type: hit.ai_shot_type || '',
      image_index: hit.image_index || null,
      total_images: hit.total_images || null,
      location:    hit.location || '',
      dimensions:  hit.dimensions || '',
      _static:     true,
    }));

    // Attach meta for pagination — will be extracted by handler
    items._meta = { estimatedTotalHits: data.estimatedTotalHits || 0 };
    return items;
  } catch { return []; }
}

// ── 10. Wikimedia Commons ─────────────────────────────────────
// Replaces BHL (BHL's ASP.NET API requires browser session cookies, unusable from serverless).
// Wikimedia Commons is free, no key needed, excellent for historical illustrations & art.
// Derives 400px thumbnail from the full URL using the standard Commons thumb path convention.
async function searchBHL(term) {
  try {
    const res = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${term}&gsrnamespace=6&gsrlimit=20&prop=imageinfo&iiprop=url|mime|extmetadata&iiextmetadatafilter=Artist|DateTimeOriginal|DateTime|ImageDescription&format=json`,
      { headers: { 'User-Agent': 'VisualArchive/1.0 (https://visual-archive-one.vercel.app; contact@visualarchive.app) node-fetch/3' } }
    );
    const data = await res.json();
    const pages = data.query?.pages;
    if (!pages) return [];

    const toThumb = (url) => {
      // https://upload.wikimedia.org/wikipedia/commons/a/ab/Image.jpg
      // → https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Image.jpg/400px-Image.jpg
      const m = url.match(/^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/)([a-f0-9]\/[a-f0-9]{2}\/)(.+)$/);
      if (!m) return url;
      const [, base, path, filename] = m;
      return `${base}thumb/${path}${filename}/400px-${filename}`;
    };

    return Object.values(pages)
      .filter(p => {
        const ii = p.imageinfo?.[0];
        if (!ii?.url) return false;
        const mime = ii.mime || '';
        return mime.startsWith('image/') && !mime.includes('svg');
      })
      .slice(0, 12)
      .map(p => {
        const ii = p.imageinfo[0];
        const title = p.title?.replace(/^File:/, '').replace(/\.[^.]+$/, '') || 'Untitled';
        const slug = encodeURIComponent(p.title?.replace(/^File:/, '') || '');
        const ext = ii.extmetadata || {};
        const stripHtml = s => (s || '').replace(/<[^>]+>/g, '').trim();
        return {
          id:          `wikimedia-${p.pageid}`,
          title,
          image_url:   toThumb(ii.url),
          source_url:  `https://commons.wikimedia.org/wiki/File:${slug}`,
          institution: 'Wikimedia Commons',
          date:        ext.DateTimeOriginal?.value?.substring(0, 4) || ext.DateTime?.value?.substring(0, 4) || '',
          creator:     stripHtml(ext.Artist?.value) || '',
          description: stripHtml(ext.ImageDescription?.value)?.substring(0, 250) || '',
          medium:      '',
        };
      });
  } catch { return []; }
}
