// api/admin/social-publish.js
//
// Publishes a post to the BookItMalta Facebook Page and/or Instagram via the
// Meta Graph API, using a never-expiring system-user Page token.
//
//   GET  /api/admin/social-publish?check=1   -> verify token + resolve Page/IG (no posting)
//   POST /api/admin/social-publish           -> publish { message, images[], targets }
//        (legacy single imageUrl still accepted; 2+ images => FB album / IG carousel)
//
// Auth: header  Authorization: Bearer <SOCIAL_PUBLISH_SECRET>   (or { secret } in body)
//   The secret lives only in Vercel env + with Julian — it is never handled by Claude.
//
// Env:
//   META_PAGE_TOKEN       system-user Page token (Sensitive)
//   META_PAGE_ID          BookItMalta Facebook Page id
//   META_IG_USER_ID       (optional) IG business account id — resolved from the Page if absent
//   SOCIAL_PUBLISH_SECRET shared secret required to call this endpoint
//
// Notes:
//   - Facebook: photo post (image url + caption) or text post (feed).
//   - Instagram REQUIRES a public image url: create media container -> publish.
//   - Stores nothing; sends no PII. Posting is gated behind the secret + Julian's preview.

const GRAPH = 'https://graph.facebook.com/v21.0';

function isAuthed(req) {
  const secret = process.env.SOCIAL_PUBLISH_SECRET || '';
  if (!secret) return false; // fail closed if not configured
  const hdr = String(req.headers['authorization'] || '');
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  const bodySecret = (req.body && req.body.secret) || '';
  return bearer === secret || bodySecret === secret;
}

async function graph(path, params, method) {
  const m = method || 'POST';
  let url = `${GRAPH}/${path}`;
  let opts = { method: m };
  if (m === 'GET') {
    url += (url.includes('?') ? '&' : '?') + new URLSearchParams(params).toString();
  } else {
    opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    opts.body = new URLSearchParams(params).toString();
  }
  const resp = await fetch(url, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    const e = data.error || {};
    throw new Error(`Graph ${m} ${path} failed: ${e.message || resp.status}`);
  }
  return data;
}

async function resolveIgUserId(pageId, token) {
  if (process.env.META_IG_USER_ID) return process.env.META_IG_USER_ID;
  const data = await graph(`${pageId}`, { fields: 'instagram_business_account', access_token: token }, 'GET');
  return data.instagram_business_account && data.instagram_business_account.id;
}

async function getPageToken(pageId, userToken) {
  // META_PAGE_TOKEN is a system-user token. Reading the Page works with it, but
  // PUBLISHING to /{page}/feed must use the Page's OWN access token, otherwise
  // Meta returns (#200) "requires ... pages_manage_posts ... as an admin". Derive
  // the Page token from the system-user token. (If META_PAGE_TOKEN is already a
  // Page token, this still returns a valid Page token.)
  const data = await graph(`${pageId}`, { fields: 'access_token', access_token: userToken }, 'GET');
  if (!data.access_token) {
    throw new Error('Could not derive a Page access token from META_PAGE_TOKEN. The system user needs Full control of the Page plus pages_show_list + pages_manage_posts.');
  }
  return data.access_token;
}

async function publishFacebook(pageId, token, message, images) {
  // No image -> text post. One image -> single photo post (unchanged behaviour).
  if (!images || images.length === 0) {
    return graph(`${pageId}/feed`, { message: message || '', access_token: token });
  }
  if (images.length === 1) {
    return graph(`${pageId}/photos`, { url: images[0], caption: message || '', access_token: token });
  }
  // Two or more -> multi-photo post: upload each unpublished, then a feed post
  // that attaches them. Photos uploaded with published=false don't appear on
  // their own; only the feed story below is visible.
  const ids = [];
  for (const url of images) {
    const photo = await graph(`${pageId}/photos`, { url, published: 'false', access_token: token });
    ids.push(photo.id);
  }
  const params = { message: message || '', access_token: token };
  ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  return graph(`${pageId}/feed`, params);
}

// Poll a media container until it finishes processing (or the budget runs out).
// Returns true if FINISHED. Bounded so we stay inside the ~10s function budget.
async function waitForContainer(containerId, token, maxMs) {
  const deadline = Date.now() + (maxMs || 6500);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    let st;
    try { st = await graph(`${containerId}`, { fields: 'status_code', access_token: token }, 'GET'); }
    catch (e) { continue; }
    if (st.status_code === 'FINISHED') return true;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
      throw new Error('Instagram rejected an image (status ' + st.status_code + ') — check the image URL is public and a supported format.');
    }
  }
  return false;
}

async function publishInstagram(pageId, token, message, images) {
  if (!images || images.length === 0) throw new Error('Instagram requires a public image URL');
  const igId = await resolveIgUserId(pageId, token);
  if (!igId) throw new Error('No Instagram business account linked to this Page');

  // Single image — keep the original fixed-wait flow (fast, within budget).
  if (images.length === 1) {
    const container = await graph(`${igId}/media`, { image_url: images[0], caption: message || '', access_token: token });
    await new Promise((r) => setTimeout(r, 6000));
    let published;
    try {
      published = await graph(`${igId}/media_publish`, { creation_id: container.id, access_token: token });
    } catch (e) {
      throw new Error('Instagram media still processing — click Publish again in a few seconds (' + e.message + ')');
    }
    return { container_id: container.id, id: published.id };
  }

  // Carousel — each image is a child container, then a CAROUSEL parent holding them.
  const childIds = [];
  for (const url of images) {
    const child = await graph(`${igId}/media`, { image_url: url, is_carousel_item: 'true', access_token: token });
    childIds.push(child.id);
  }
  const parent = await graph(`${igId}/media`, {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption: message || '',
    access_token: token,
  });
  // Wait for the carousel to finish processing, then publish. If it isn't ready
  // inside the budget, ask the user to click Publish again (same pattern as the
  // single-image path) rather than risk a function timeout. Budget is kept short
  // (4.5s) because Facebook may have already run before this in the same request
  // (the function has a ~10s ceiling) — small site images finish on the first
  // poll, and a tight budget means we return our own "try again" message instead
  // of being killed mid-flight (which on retry would re-post the FB album).
  const ready = await waitForContainer(parent.id, token, 4500);
  if (!ready) {
    throw new Error('Instagram carousel still processing — click Publish again in a few seconds.');
  }
  let published;
  try {
    published = await graph(`${igId}/media_publish`, { creation_id: parent.id, access_token: token });
  } catch (e) {
    throw new Error('Instagram carousel still processing — click Publish again in a few seconds (' + e.message + ')');
  }
  return { container_id: parent.id, children: childIds, id: published.id };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!isAuthed(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.META_PAGE_TOKEN;
  const pageId = process.env.META_PAGE_ID;
  if (!token || !pageId) {
    return res.status(500).json({ error: 'META_PAGE_TOKEN / META_PAGE_ID not configured' });
  }

  // GET ?check — verify wiring without posting
  if (req.method === 'GET') {
    try {
      const pageToken = await getPageToken(pageId, token);
      const page = await graph(`${pageId}`, { fields: 'id,name', access_token: pageToken }, 'GET');
      let instagram = null;
      try {
        const igId = await resolveIgUserId(pageId, pageToken);
        if (igId) instagram = await graph(`${igId}`, { fields: 'id,username', access_token: pageToken }, 'GET');
      } catch (e) { instagram = { error: e.message }; }
      return res.status(200).json({ ok: true, page, instagram, pageToken: 'derived' });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const message = (body.message || '').toString();
  // Accept images[] (carousel-aware) or the legacy single imageUrl. Normalise to
  // a clean, de-duplicated list of public URLs; cap at 10 (Meta's carousel limit).
  let images = [];
  if (Array.isArray(body.images)) images = body.images;
  else if (body.imageUrl) images = [body.imageUrl];
  if (body.imageUrl && !images.includes(body.imageUrl)) images.unshift(body.imageUrl);
  images = images.map((u) => String(u || '').trim()).filter(Boolean);
  images = images.filter((u, i) => images.indexOf(u) === i).slice(0, 10);
  let targets = body.targets;
  if (!Array.isArray(targets) || targets.length === 0) targets = ['facebook'];
  targets = targets.map((t) => String(t).toLowerCase());

  if (!message && images.length === 0) {
    return res.status(400).json({ error: 'Provide a message and/or at least one image' });
  }

  // META_PAGE_TOKEN is a system-user token; derive the Page's own token to publish.
  let pageToken;
  try { pageToken = await getPageToken(pageId, token); }
  catch (e) { return res.status(502).json({ ok: false, results: { error: e.message } }); }

  const results = {};
  let anyOk = false;

  if (targets.includes('facebook') || targets.includes('fb')) {
    try { results.facebook = { ok: true, ...(await publishFacebook(pageId, pageToken, message, images)) }; anyOk = true; }
    catch (e) { results.facebook = { ok: false, error: e.message }; }
  }
  if (targets.includes('instagram') || targets.includes('ig')) {
    try { results.instagram = { ok: true, ...(await publishInstagram(pageId, pageToken, message, images)) }; anyOk = true; }
    catch (e) { results.instagram = { ok: false, error: e.message }; }
  }

  return res.status(anyOk ? 200 : 502).json({ ok: anyOk, results });
};
