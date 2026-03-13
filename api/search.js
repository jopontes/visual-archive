// Visual Archive — Serverless Search Function (Vercel)
// Queries 5 institutional APIs in parallel and returns normalised results.

export default async function handler(req, res) {
  // CORS — allow requests from any origin (GitHub Pages, localhost, etc.)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: 'Missing search query parameter: q' });
  }

  const term = encodeURIComponent(q.trim());

  const results = await Promise.allSettled([
    searchMet(term),
    searchArtic(term),
    searchRijksmuseum(term),
    searchSmithsonian(term),
    searchEuropeana(term),
  ]);

  // Flatten, filter items without images, cap at 60
  const items = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(item => item && item.image_url)
    .slice(0, 60);

  return res.status(200).json(items);
}

// ── 1. Met Museum ──────────────────────────────────────────────
async function searchMet(term) {
  try {
    const searchRes = await fetch(
      `https://collectionapi.metmuseum.org/public/collection/v1/search?q=${term}&hasImages=true`
    );
    const searchData = await searchRes.json();
    if (!searchData.objectIDs?.length) return [];

    const ids = searchData.objectIDs.slice(0, 12);
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
        institution: 'Met Museum',
        date:        r.value.objectDate || '',
      }));
  } catch {
    return [];
  }
}

// ── 2. Art Institute of Chicago ────────────────────────────────
async function searchArtic(term) {
  try {
    const res = await fetch(
      `https://api.artic.edu/api/v1/artworks/search?q=${term}&fields=id,title,image_id,date_display&limit=12`
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
        institution: 'Art Institute Chicago',
        date:        item.date_display || '',
      }));
  } catch {
    return [];
  }
}

// ── 3. Rijksmuseum ─────────────────────────────────────────────
async function searchRijksmuseum(term) {
  const key = process.env.RIJKSMUSEUM_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://www.rijksmuseum.nl/api/nl/collection?q=${term}&key=${key}&imgonly=True&ps=12`
    );
    const data = await res.json();
    if (!data.artObjects?.length) return [];

    return data.artObjects
      .filter(item => item.webImage?.url)
      .map(item => ({
        id:          `rijks-${item.objectNumber}`,
        title:       item.title || 'Untitled',
        image_url:   item.webImage.url,
        source_url:  item.links?.web || `https://www.rijksmuseum.nl/nl/collectie/${item.objectNumber}`,
        institution: 'Rijksmuseum',
        date:        item.longTitle || '',
      }));
  } catch {
    return [];
  }
}

// ── 4. Smithsonian ─────────────────────────────────────────────
async function searchSmithsonian(term) {
  const key = process.env.SMITHSONIAN_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://api.si.edu/openaccess/api/v1.0/search?q=${term}&api_key=${key}&rows=12`
    );
    const data = await res.json();
    const rows = data.response?.rows;
    if (!rows?.length) return [];

    const items = [];
    for (const row of rows) {
      try {
        const dnr = row.content?.descriptiveNonRepeating;
        if (!dnr) continue;

        // Find online_media with a thumbnail/image
        const mediaArray = dnr.online_media?.media;
        const media = Array.isArray(mediaArray)
          ? mediaArray.find(m => m.thumbnail || m.content)
          : null;

        const image_url = media?.thumbnail || media?.content;
        if (!image_url) continue;

        items.push({
          id:          `si-${row.id}`,
          title:       dnr.title?.content || row.title || 'Untitled',
          image_url,
          source_url:  dnr.record_link || `https://www.si.edu/object/${row.id}`,
          institution: 'Smithsonian',
          date:        row.content?.freetext?.date?.[0]?.content || '',
        });
      } catch {
        // skip malformed row
      }
    }
    return items;
  } catch {
    return [];
  }
}

// ── 5. Europeana ───────────────────────────────────────────────
async function searchEuropeana(term) {
  const key = process.env.EUROPEANA_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://api.europeana.eu/record/v2/search.json?query=${term}&wskey=${key}&rows=12&media=true`
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
      }));
  } catch {
    return [];
  }
}
