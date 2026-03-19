// Visual Archive — Source Document Counts
// Returns real document counts per source_slug from Meilisearch facets.
// Used by the frontend to display accurate counts for each scraped database.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-secret');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const secret = process.env.API_SECRET;
  if (secret && req.headers['x-api-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const meiliUrl = process.env.MEILI_URL;
  const meiliKey = process.env.MEILI_KEY;
  if (!meiliUrl || !meiliKey) {
    return res.status(500).json({ error: 'Meilisearch not configured' });
  }

  try {
    const r = await fetch(
      `${meiliUrl.replace(/\/$/, '')}/indexes/visual_archive/search`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${meiliKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: '',
          limit: 0,
          facets: ['source_slug'],
        }),
      }
    );

    if (!r.ok) {
      return res.status(502).json({ error: 'Meilisearch error', status: r.status });
    }

    const data = await r.json();
    const counts = data.facetDistribution?.source_slug || {};

    // Cache for 1 hour — counts change slowly
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    return res.status(200).json(counts);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
