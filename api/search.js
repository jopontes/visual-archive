// Visual Archive — Serverless Search Function (Vercel)
// Queries 10 institutional APIs + Meilisearch static index in parallel.
// NOTE: Rijksmuseum removed in March 2026 — old API (rijksmuseum.nl/api) returned HTTP 410 Gone.
// New API (data.rijksmuseum.nl) only supports filters (creator=, type=), not free-text search.
//
// Parameters:
//   ?q=TERM                — search term (required unless discover=1)
//   ?discover=1            — returns random results from a curated term set (no q needed)
//   ?sources=vam,artic,met — comma-separated source filter (default: all)
//   ?category=film         — filter static index by category (film|art|photography|design|typography)

const SOURCE_KEYS = [
  'vam', 'artic', 'smithsonian', 'europeana', 'met',
  'wellcome', 'nasa', 'loc', 'nypl', 'bhl',
  'meilisearch',  // ← static scraped databases
];

// Sources included by default (no ?sources= param).
// NASA and Wikimedia Commons are opt-in only (too noisy for most searches).
const DEFAULT_SOURCES = [
  'vam', 'artic', 'smithsonian', 'europeana', 'met',
  'wellcome', 'loc', 'nypl',
  'meilisearch',
];

const DISCOVER_TERMS = [
  'portrait', 'landscape', 'textile', 'vessel', 'garden',
  'costume', 'drawing', 'ornament', 'ritual', 'map',
  'manuscript', 'flower', 'mask', 'figure', 'architecture',
  'still life', 'monument', 'ceramic', 'tapestry', 'light',
  'botanical', 'astronomical', 'specimen', 'anatomy', 'insect',
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

  const { q, discover, sources: sourcesParam } = req.query;

  // Resolve active sources
  const activeSources = sourcesParam
    ? sourcesParam.split(',').map(s => s.trim()).filter(s => SOURCE_KEYS.includes(s))
    : DEFAULT_SOURCES;

  // Resolve search term
  let term;
  if (discover === '1') {
    const idx = Math.floor(Math.random() * DISCOVER_TERMS.length);
    term = encodeURIComponent(DISCOVER_TERMS[idx]);
  } else {
    if (!q || !q.trim()) return res.status(400).json({ error: 'Missing parameter: q' });
    term = encodeURIComponent(q.trim());
  }

  // Build fetch promises for active sources only
  const { category } = req.query;
  const fetchers = {
    vam:         () => searchVAMuseum(term),
    artic:       () => searchArtic(term),
    smithsonian: () => searchSmithsonian(term),
    europeana:   () => searchEuropeana(term),
    met:         () => searchMet(term),
    wellcome:    () => searchWellcome(term),
    nasa:        () => searchNASA(term),
    loc:         () => searchLOC(term),
    nypl:        () => searchNYPL(term),
    bhl:         () => searchBHL(term),
    meilisearch: () => searchMeilisearch(term, { category }),
  };

  const results = await Promise.allSettled(
    activeSources.map(key => fetchers[key]())
  );

  const institutionPriority = {
    'V&A Museum':                   0,
    'Art Institute Chicago':         1,
    'Smithsonian':                   2,
    'Europeana':                     3,
    'Met Museum':                    4,
    'Wellcome Collection':           5,
    'Library of Congress':           6,
    'NYPL':                          7,
    'NASA':                          8,
    'Wikimedia Commons':             9,
  };

  // Non-image extension filter — catch PDFs, DjVu, etc. that slip through
  const NON_IMAGE_EXTS = ['.pdf', '.djvu', '.epub', '.doc', '.docx', '.ps', '.eps'];

  const allItems = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(item => {
      if (!item || !item.image_url) return false;
      const urlPath = item.image_url.toLowerCase().split('?')[0];
      return !NON_IMAGE_EXTS.some(ext => urlPath.endsWith(ext));
    });

  // Separate scraped database results (_static) from live API results
  const staticItems = allItems.filter(i => i._static);
  const liveItems   = allItems.filter(i => !i._static);

  let items;
  if (discover === '1') {
    items = allItems.sort(() => Math.random() - 0.5);
  } else {
    // Sort live results by institution priority
    liveItems.sort((a, b) =>
      (institutionPriority[a.institution] ?? 999) - (institutionPriority[b.institution] ?? 999)
    );
    // Interleave: 2 live results then 1 static, so scraped items always appear
    items = [];
    let l = 0, s = 0;
    while (l < liveItems.length || s < staticItems.length) {
      if (l < liveItems.length) items.push(liveItems[l++]);
      if (l < liveItems.length) items.push(liveItems[l++]);
      if (s < staticItems.length) items.push(staticItems[s++]);
    }
  }

  return res.status(200).json(items.slice(0, 120));
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

// ── 4. Europeana ───────────────────────────────────────────────
async function searchEuropeana(term) {
  const key = process.env.EUROPEANA_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://api.europeana.eu/record/v2/search.json?query=${term}&wskey=${key}&rows=12&media=true&qf=TYPE:IMAGE`
    );
    const data = await res.json();
    if (!data.items?.length) return [];
    return data.items
      .filter(item => item.edmPreview?.length)
      .map(item => ({
        id:          `europeana-${encodeURIComponent(item.id)}`,
        title:       Array.isArray(item.title) ? item.title[0] : (item.title || 'Untitled'),
        image_url:   item.edmPreview[0],
        source_url:  item.guid || `https://www.europeana.eu/item${item.id}`,
        institution: 'Europeana',
        date:        item.year?.[0] || '',
        creator:     item.dcCreator?.[0] || '',
        medium:      '',
        institution_detail: item.dataProvider?.[0] || '',
        description: Array.isArray(item.dcDescription) ? item.dcDescription[0] : (item.dcDescription || ''),
        subject:     Array.isArray(item.dcSubject) ? item.dcSubject.slice(0, 5).join(', ') : '',
      }));
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
        image_url:   item.thumbnail.url.replace(/\/full\/.*?\/0\//, '/full/600,/0/'),
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

// ── 8. Library of Congress ─────────────────────────────────────
// Note: image_url field is an array of URLs (smallest→largest).
async function searchLOC(term) {
  try {
    const res = await fetch(
      `https://www.loc.gov/photos/?q=${term}&fo=json&c=12`
    );
    const data = await res.json();
    if (!data.results?.length) return [];
    return data.results
      .filter(item => item.image_url?.length)
      .map(item => ({
        id:          `loc-${encodeURIComponent(item.id || item.url || String(Math.random()))}`,
        title:       Array.isArray(item.title) ? item.title[0] : (item.title || 'Untitled'),
        // Use largest available (last element), fallback to first
        image_url:   item.image_url[item.image_url.length - 1] || item.image_url[0],
        source_url:  item.url || 'https://www.loc.gov/photos/',
        institution: 'Library of Congress',
        date:        item.date || '',
        creator:     Array.isArray(item.contributor) ? item.contributor[0] : (item.contributor || ''),
        medium:      '',
        description: Array.isArray(item.description) ? item.description[0] : (item.description || ''),
        subject:     Array.isArray(item.subject) ? item.subject.slice(0, 4).join(', ') : (item.subject || ''),
      }));
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
async function searchMeilisearch(term, { category } = {}) {
  const meiliUrl = process.env.MEILI_URL;
  const meiliKey = process.env.MEILI_KEY;
  if (!meiliUrl || !meiliKey) return [];

  try {
    // Build filter string (only filterable fields: category, source_slug, year, medium)
    const filters = [];
    if (category) filters.push(`category = "${category}"`);

    const body = {
      q:                    decodeURIComponent(term),
      limit:                30,
      attributesToRetrieve: [
        'id', 'title', 'creator', 'year', 'medium', 'category',
        'source', 'source_slug', 'description', 'tags',
        'image_url', 'stills', 'item_url', 'location', 'dimensions',
      ],
      attributesToHighlight: ['title', 'creator'],
      highlightPreTag:       '<mark>',
      highlightPostTag:      '</mark>',
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
    if (!data.hits?.length) return [];

    return data.hits.map(hit => ({
      id:          hit.id,
      title:       hit._formatted?.title || hit.title || 'Untitled',
      image_url:   hit.image_url,
      source_url:  hit.item_url || '',
      institution: hit.source || 'Visual Archive',
      date:        hit.year ? String(hit.year) : '',
      creator:     hit._formatted?.creator || hit.creator || '',
      medium:      hit.medium || '',
      category:    hit.category || '',
      source_slug: hit.source_slug || '',
      description: hit.description || '',
      tags:        hit.tags || [],
      stills:      hit.stills || [],
      location:    hit.location || '',
      dimensions:  hit.dimensions || '',
      // Flag so the frontend knows this came from static index
      _static:     true,
    }));
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
